/**
 * The adapters a runner speaks to its agent through: where a subagent came from, the context it runs under, the
 * subagent sessions the host keeps, and what an agent's updates mean to the conversation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { requestIdKey } from "../../source/adapters/interop/chat-inference-proto/client.ts";
import { InteractionUpdate, TextDeltaUpdate } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { slateTaskProgressUpdateFromInterop } from "../../source/adapters/interop/agent/task-progress-protocol-adapter.ts";
import { toRedactedInteractionListener, toUnredactedInteractionListener } from "../../source/adapters/interop/agent/redacted-interaction-listener-adapter.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { InteractionHandler } from "../../source/packages/agent/interaction-handler.ts";
import { PrivacyCapability } from "../../source/packages/redaction/classification.ts";
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts";
import { isRedactedString } from "../../source/packages/redaction/redacted-values.ts";
import { isSlateRedactedInteractionUpdate } from "../../source/packages/agent-core/slate-interaction-updates.ts";
import { withRootParentRequestId } from "../../source/packages/agent/utils/request-scope.ts";
import { ToolCall } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { ShellArgs } from "../../source/adapters/interop/proto/generated/agent/v1/shell_exec_pb.ts";
import { SlateInteractionUpdates } from "../../source/packages/agent-core/slate-interaction-updates.ts";
import { slateInteractionToolCallValueFromInterop } from "../../source/adapters/interop/agent/interaction-tool-call-adapter.ts";
import { computeSubagentRequestId } from "../../source/host/runner/subagent-runtime.ts";
import { SlateSubagentDispatchError, SlateRequestContextExecutor, SlateSubagentHostAdapter, ForwardingInteractionListener, deriveSlateSubagentRequestLineage, type SubagentAdapterArgs } from "../../source/host/runner/agent-adapters.ts";
import type { SlateTaskProgressUpdate } from "../../source/packages/agent/tools/task-progress-state.ts";

const args = (over: Partial<SubagentAdapterArgs> = {}): SubagentAdapterArgs => ({ subagentType: "generalPurpose", toolCallId: "call-1", prompt: "look into it", ...over });

describe("where a subagent came from", () => {
  it("says nothing when the call has no request of its own, and where it came from when it has", () => {
    assert.equal(deriveSlateSubagentRequestLineage(createContext(), "call-1"), undefined);
    const withRequest = createContext().with(requestIdKey, "request-1");
    assert.deepEqual(deriveSlateSubagentRequestLineage(withRequest, "call-1"), { parentRequestId: "request-1", rootParentRequestId: "request-1", parentAgentToolCallId: "call-1" });
    // The root is the outermost request the platform remembers, and a call with no id of its own carries none.
    const rooted = withRootParentRequestId(createContext().with(requestIdKey, "request-2"), "request-0");
    const lineage = deriveSlateSubagentRequestLineage(rooted, "");
    assert.deepEqual({ parent: lineage?.parentRequestId, root: lineage?.rootParentRequestId, toolCall: lineage?.parentAgentToolCallId }, { parent: "request-2", root: "request-0", toolCall: undefined });
    // An empty request id is treated as none at all.
    assert.equal(deriveSlateSubagentRequestLineage(createContext().with(requestIdKey, ""), "call-1"), undefined);
  });
});

describe("the context a turn runs under", () => {
  it("says what the machine is, what rules apply and what the agent can do", async () => {
    const executor = new SlateRequestContextExecutor(
      { resolve: () => ({ osVersion: "Darwin 27", shell: "/bin/zsh", timeZone: "Europe/Berlin", transcriptsFolder: "/transcripts" }), resolveRules: async () => undefined },
      true,
      true,
      () => [{ fullPath: "/skills/write-notes", description: "writes notes" }] as never,
    );
    const result = await executor.execute();
    const context = result.result.case === "success" ? result.result.value.requestContext : undefined;
    assert.deepEqual({ os: context?.env?.osVersion, shell: context?.env?.shell, zone: context?.env?.timeZone, folder: context?.env?.agentTranscriptsFolder, autoMode: context?.env?.smartModeClassifierAutoModeEnabled }, { os: "Darwin 27", shell: "/bin/zsh", zone: "Europe/Berlin", folder: "/transcripts", autoMode: true });
    // Rules that were not read are not claimed to be complete, and the skills the agent has are carried as they are.
    assert.deepEqual({ rules: context?.rules, complete: context?.rulesInfoComplete, skills: context?.agentSkills?.map((skill) => (skill as { fullPath: string }).fullPath) }, { rules: [], complete: false, skills: ["/skills/write-notes"] });
    // A turn that does not carry the transcripts folder leaves it out, and one with no skills has none.
    const bare = new SlateRequestContextExecutor({ resolve: () => ({ osVersion: "Darwin 27", shell: "/bin/zsh", timeZone: "UTC", transcriptsFolder: "/transcripts" }), resolveRules: async () => [{ name: "be brief" }] as never }, false, false);
    const bareResult = await bare.execute();
    const bareContext = bareResult.result.case === "success" ? bareResult.result.value.requestContext : undefined;
    assert.deepEqual({ folder: bareContext?.env?.agentTranscriptsFolder, autoMode: bareContext?.env?.smartModeClassifierAutoModeEnabled, rules: bareContext?.rules?.length, complete: bareContext?.rulesInfoComplete, skills: bareContext?.agentSkills?.length }, { folder: "", autoMode: false, rules: 1, complete: true, skills: 0 });
    const noRules = new SlateRequestContextExecutor({ resolve: () => ({}), resolveRules: async () => [] }, false, false);
    const noRulesResult = await noRules.execute();
    const noRulesContext = noRulesResult.result.case === "success" ? noRulesResult.result.value.requestContext : undefined;
    assert.deepEqual({ rules: noRulesContext?.rules, complete: noRulesContext?.rulesInfoComplete }, { rules: [], complete: true });
  });
});

describe("the subagent sessions a host keeps", () => {
  function harness() {
    const calls: unknown[][] = [];
    const sessions = new Map<string, never>();
    const windows = new Set<string>();
    const runningToolCalls = new Set<string>();
    const adapter = new SlateSubagentHostAdapter(
      sessions,
      (id, sessionArgs) => {
        calls.push(["create", id, sessionArgs.prompt]);
        return { run: async (prompt: string, runOptions: unknown) => { calls.push(["run", id, prompt, runOptions]); return { text: "done" }; } } as never;
      },
      {
        isRunning: (id) => { calls.push(["is-running", id]); return running.has(id); },
        hasRunningToolCall: (toolCallId) => { calls.push(["has-running-tool-call", toolCallId]); return runningToolCalls.has(toolCallId); },
        allocateComputerUseWindow: (id) => { calls.push(["allocate", id]); if (windows.size > 0) return null; windows.add(id); return { window: id }; },
        freeComputerUseWindow: (id) => { calls.push(["free", id]); windows.delete(id); },
        dispatch: (dispatchArgs) => { calls.push(["dispatch", dispatchArgs]); },
      },
    );
    const running = new Set<string>();
    return { adapter, sessions, windows, running, runningToolCalls, calls, kinds: (of: string) => calls.filter((call) => call[0] === of) };
  }

  it("acknowledges a background handoff only for a live subagent tool call", () => {
    const world = harness();
    assert.equal(world.adapter.hasRunningToolCall("call-1"), false);
    world.runningToolCalls.add("call-1");
    assert.equal(world.adapter.hasRunningToolCall("call-1"), true);
    assert.equal(world.adapter.hasRunningToolCall(""), false);
  });

  it("makes a session or resumes one, and keeps a computer-use subagent to a single desktop", async () => {
    const world = harness();
    world.sessions.set("subagent-old", { run: async () => ({ text: "again" }) } as never);
    // A session that is there and idle is resumed as it is; one that is still running cannot be.
    assert.equal(await world.adapter.createOrResumeSession(undefined, args({ resumeAgentId: "subagent-old" })), "subagent-old");
    world.running.add("subagent-old");
    await world.adapter.createOrResumeSession(undefined, args({ resumeAgentId: "subagent-old" })).then(
      () => assert.fail("a subagent that was still running was resumed"),
      (error: Error) => { assert.equal(error instanceof SlateSubagentDispatchError, true); assert.equal(error.message, "That background subagent is still running, so it can't be resumed yet — use MessageSubagent or StopSubagent while it runs."); },
    );
    // A new one is given an id of its own and its runner is made.
    const made = await world.adapter.createOrResumeSession(undefined, args({ prompt: "check the release" }));
    assert.equal(made.startsWith("subagent-"), true);
    assert.deepEqual(world.kinds("create").map((call) => call[2]), ["check the release"]);
    assert.equal(await world.adapter.createOrResumeSession(undefined, args({ resumeAgentId: "subagent-not-yet-created" })), "subagent-not-yet-created");
    assert.deepEqual(world.kinds("create").map((call) => [call[1], call[2]]), [[made, "check the release"], ["subagent-not-yet-created", "look into it"]]);
    // Only one computer-use subagent may hold the box's desktop, whichever way its type is spelled.
    assert.equal(await world.adapter.createOrResumeSession(undefined, args({ subagentType: "computerUse" })).then(() => "made"), "made");
    // The next one, however its type is spelled, cannot have it.
    for (const subagentType of ["computerUse", "computer_use", "computer use", "ComputerUse"]) {
      assert.equal(await world.adapter.createOrResumeSession(undefined, args({ subagentType })).then(() => "made", (error: Error) => error.message), "A computerUse subagent is already using the box's desktop. Only one can run at a time.");
    }
    assert.equal(world.windows.size, 1);
    assert.equal(await world.adapter.createOrResumeSession(undefined, args({ subagentType: "other" })).then(() => "made"), "made");
  });

  it("gives the desktop back when a subagent could not be made", async () => {
    const world = harness();
    const failing = new SlateSubagentHostAdapter(new Map(), () => { throw new Error("no runner for you"); }, (world.adapter as unknown as { dispatcher: never }).dispatcher);
    await failing.createOrResumeSession(undefined, args({ subagentType: "computerUse" })).then(
      () => assert.fail("a subagent was made without a runner"),
      (error: Error) => assert.equal(error.message, "no runner for you"),
    );
    // The window it took is given back, so the next computer-use subagent can have it.
    assert.equal(world.windows.size, 0);
    assert.equal(await world.adapter.createOrResumeSession(undefined, args({ subagentType: "computerUse" })).then(() => "made", (error: Error) => error.message), "made");
  });

  it("dispatches a run in the background, wherever it came from, unless the platform turns it down", async () => {
    const world = harness();
    const id = await world.adapter.createOrResumeSession(undefined, args());
    // A session the host does not have, and one that is already running, are both refused in their own words.
    assert.deepEqual(await world.adapter.runSession(undefined, "subagent-nobody", args()), { status: "error", error: "Unknown Slate subagent: subagent-nobody" });
    world.running.add(id);
    assert.deepEqual(await world.adapter.runSession(undefined, id, args()), { status: "error", error: "That background subagent is already running." });
    world.running.delete(id);
    // A reviewer that turns the launch down releases the session and says why.
    world.adapter.setLaunchReviewer(async () => ({ allowed: false, reason: "not from here" }));
    assert.deepEqual(await world.adapter.runSession(undefined, id, args()), { status: "error", error: "not from here" });
    assert.equal(world.sessions.has(id), false);
    // What was dispatched carries where it came from and what it was asked to do.
    const allowed = harness();
    const sessionId = await allowed.adapter.createOrResumeSession(undefined, args({ subagentType: "computerUse" }));
    allowed.adapter.setLaunchReviewer(async () => ({ allowed: true, reason: "" }));
    const ctx = createContext().with(requestIdKey, "request-9");
    const selectedImage = { id: "image-1", sourcePath: "one.png", mediaType: "image/png", content: { kind: "inline-bytes", bytes: new Uint8Array([1, 2]) } as const };
    const selectedVideo = { sourcePath: "one.mov", displayName: "one.mov", mediaType: "video/mp4", writeToWorkspace: false, content: { kind: "empty" } as const };
    assert.deepEqual(await allowed.adapter.runSession(ctx, sessionId, args({ subagentType: "computerUse", toolCallId: "call-9", prompt: "check it", selectedContext: { images: [selectedImage], videos: [selectedVideo], commands: [] } })), { status: "background", backgroundReason: "agent-request", toolCallCount: 0 });
    const dispatched = allowed.kinds("dispatch")[0]?.[1] as { subagentAgentId: string; subagentType: string; toolCallId: string; prompt: string; lineage?: { parentRequestId: string }; run(): Promise<{ text: string }> };
    assert.deepEqual({ id: dispatched.subagentAgentId, type: dispatched.subagentType, call: dispatched.toolCallId, prompt: dispatched.prompt, parent: dispatched.lineage?.parentRequestId }, { id: sessionId, type: "computerUse", call: "call-9", prompt: "check it", parent: "request-9" });
    // The run it was given calls the session's runner with what the caller selected and against the same request.
    const outcome = await dispatched.run();
    assert.equal(outcome.text, "done");
    const run = allowed.kinds("run")[0] as [string, string, string, { selectedImages?: readonly unknown[]; selectedVideos?: readonly unknown[]; inferenceRequestId?: string; lineage?: { parentRequestId: string } }] | undefined;
    assert.deepEqual({ prompt: run?.[2], images: run?.[3].selectedImages, videos: run?.[3].selectedVideos, request: run?.[3].inferenceRequestId, parent: run?.[3].lineage?.parentRequestId }, {
      prompt: "check it",
      images: [selectedImage],
      videos: [selectedVideo],
      request: computeSubagentRequestId("call-9"),
      parent: "request-9",
    });

    const noCallId = harness();
    const noCallIdSession = await noCallId.adapter.createOrResumeSession(undefined, args({ toolCallId: "" }));
    await noCallId.adapter.runSession(createContext(), noCallIdSession, args({ toolCallId: "" }));
    const noCallDispatch = noCallId.kinds("dispatch")[0]?.[1] as { lineage?: unknown; run(): Promise<{ text: string }> };
    assert.equal(noCallDispatch.lineage, undefined);
    assert.equal(Object.hasOwn(noCallDispatch, "lineage"), false);
    await noCallDispatch.run();
    const noCallRun = noCallId.kinds("run")[0] as [string, string, string, { inferenceRequestId?: string; lineage?: unknown }] | undefined;
    assert.deepEqual({ prompt: noCallRun?.[2], request: noCallRun?.[3].inferenceRequestId, lineage: noCallRun?.[3].lineage }, { prompt: "look into it", request: undefined, lineage: undefined });

    const desktopDenied = harness();
    const desktopSession = await desktopDenied.adapter.createOrResumeSession(undefined, args({ subagentType: "computerUse" }));
    desktopDenied.adapter.setLaunchReviewer(async () => ({ allowed: false, reason: "desktop launch refused" }));
    assert.deepEqual(await desktopDenied.adapter.runSession(undefined, desktopSession, args({ subagentType: "computerUse" })), { status: "error", error: "desktop launch refused" });
    assert.deepEqual({ retained: desktopDenied.sessions.has(desktopSession), windows: desktopDenied.windows.size, freed: desktopDenied.kinds("free").map((call) => call[1]) }, { retained: false, windows: 0, freed: [desktopSession] });
    // A subagent whose type was left out is a general one.
    const plain = harness();
    const plainId = await plain.adapter.createOrResumeSession(undefined, args({ subagentType: "" }));
    await plain.adapter.runSession(createContext(), plainId, args({ subagentType: "" }));
    assert.equal((plain.kinds("dispatch")[0]?.[1] as { subagentType: string }).subagentType, "generalPurpose");
  });

  it("puts a session away only when it is not running", async () => {
    const world = harness();
    const id = await world.adapter.createOrResumeSession(undefined, args({ subagentType: "computerUse" }));
    world.running.add(id);
    world.adapter.releaseSession(id);
    assert.equal(world.sessions.has(id), true);
    assert.deepEqual(world.kinds("free"), []);
    world.running.delete(id);
    world.adapter.releaseSession(id);
    assert.equal(world.sessions.has(id), false);
    assert.deepEqual(world.kinds("free").map((call) => call[1]), [id]);
  });
});

describe("what an agent's updates mean to the conversation", () => {
  function listener(observers: ConstructorParameters<typeof ForwardingInteractionListener>[1] = {}) {
    const updates: Array<Record<string, unknown>> = [];
    return { updates, listener: new ForwardingInteractionListener((update) => { updates.push(update); }, observers) };
  }
  const shellCall = new ToolCall({ tool: { case: "shellToolCall", value: { args: new ShellArgs({ command: "ls -la" }) } as never } });
  const toolUpdate = (phase: string, toolCall: unknown = shellCall, modelCallId = "") => ({ message: { case: phase, value: { callId: "call-1", toolCall, modelCallId } } });

  it("forwards what the agent said and thought, and how the turn ended", async () => {
    const { listener: forwarding, updates } = listener();
    await forwarding.sendUpdate({}, { message: { case: "textDelta", value: { text: "hi" } } });
    await forwarding.sendUpdate({}, { message: { case: "thinkingDelta", value: { text: "hmm" } } });
    // A turn that says what it used carries it; one that says nothing carries only that it ended.
    await forwarding.sendUpdate({}, { message: { case: "turnEnded", value: { inputTokens: 5, outputTokens: 2 } } });
    await forwarding.sendUpdate({}, { message: { case: "turnEnded", value: {} } });
    assert.deepEqual(updates.map((update) => [update.type, update.text ?? (update.usage == null ? null : "usage")]), [["text-delta", "hi"], ["thinking-delta", "hmm"], ["turn-ended", "usage"], ["turn-ended", null]]);
    // An update the conversation has nothing to say about is passed over.
    updates.length = 0;
    await forwarding.sendUpdate({}, { message: { case: "somethingElse", value: {} } });
    assert.deepEqual(updates, []);
  });

  it("forwards Slate task progress as a host update", async () => {
    const { listener: forwarding, updates } = listener();
    const progress: SlateTaskProgressUpdate = {
      schemaVersion: 1,
      kind: "assistant-text",
      text: "child output",
      serverNotice: false,
    };
    await forwarding.sendTaskProgressUpdate({}, "task-call-1", "invocation-1", progress);
    assert.deepEqual(updates, [{ type: "task-progress", toolCallId: "task-call-1", modelCallId: "invocation-1", update: progress }]);
  });

  it("projects child progress through the privacy-aware parent listener", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const hostListener = new ForwardingInteractionListener(update => { updates.push(update); });
    const redacted = toRedactedInteractionListener(hostListener, PrivacyMode.NO_TRAINING);
    const interaction = toUnredactedInteractionListener(redacted, PrivacyMode.NO_TRAINING);
    const handler = new InteractionHandler(interaction, {} as never, "parent-invocation");
    const childMessage = new InteractionUpdate({
      message: { case: "textDelta", value: new TextDeltaUpdate({ text: "private child code" }) },
    });
    const childUpdate = slateTaskProgressUpdateFromInterop(childMessage);

    assert.equal(await handler.emitTaskProgressUpdate(createContext(), "task-call-1", childUpdate), true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.type, "task-progress");
    assert.equal(updates[0]?.toolCallId, "task-call-1");
    assert.equal(updates[0]?.modelCallId, "parent-invocation");
    const forwarded = updates[0]?.update as { kind?: string; text?: string; compatibility?: unknown };
    assert.equal(forwarded.kind, "assistant-text");
    assert.equal(forwarded.text, "[redacted:text]");
    assert.equal(forwarded.compatibility, undefined);
  });

  it("forwards a tool call with what it is doing, and what the surface makes of it", async () => {
    const seen: unknown[][] = [];
    const { listener: forwarding, updates } = listener({
      onToolCall: (phase, callId, toolCall) => { seen.push(["seen", phase, callId, toolCall != null]); },
      resolveToolName: (_phase, _callId, fallback) => (fallback === "shellToolCall" ? "Shell" : fallback),
    });
    await forwarding.sendUpdate({}, toolUpdate("toolCallStarted", shellCall, "model-call-1"));
    const forwarded = updates[0] as { type: string; id: string; name: string; status: string; summary?: unknown; args?: unknown };
    assert.deepEqual({ type: forwarded.type, id: forwarded.id, name: forwarded.name, status: forwarded.status }, { type: "tool-call", id: "call-1", name: "Shell", status: "pending" });
    assert.deepEqual(seen, [["seen", "started", "call-1", true]]);
    // The same call is also offered to the surface the user sees, as its own update.
    const projected = updates[1] as { type: string; update: { kind: string; value: { toolCallId: string } } };
    assert.deepEqual({ type: projected.type, kind: projected.update.kind, call: projected.update.value.toolCallId }, { type: "client-side-tool-v2", kind: "call", call: "call-1" });
    // A completed call is done rather than pending, and a call with nothing in it is passed over.
    updates.length = 0;
    await forwarding.sendUpdate({}, toolUpdate("toolCallCompleted"));
    assert.equal((updates[0] as { status: string }).status, "done");
    updates.length = 0;
    await forwarding.sendUpdate({}, { message: { case: "toolCallStarted", value: { callId: "call-2" } } });
    assert.deepEqual(updates, []);
  });

  it("forwards Slate-owned tool-call events through the same client projection", async () => {
    const seen: unknown[][] = [];
    const { listener: forwarding, updates } = listener({
      onToolCall: (phase, callId, toolCall) => { seen.push([phase, callId, toolCall != null]); },
    });
    const toolCall = slateInteractionToolCallValueFromInterop(shellCall, "call-7");
    await forwarding.sendUpdate({}, SlateInteractionUpdates.toolCallStarted("call-7", toolCall, "model-call-7"));
    assert.equal((updates[0] as { type: string; id: string; status: string }).type, "tool-call");
    assert.deepEqual(seen, [["started", "call-7", true]]);
    assert.equal((updates[1] as { type: string }).type, "client-side-tool-v2");
  });

  it("redacts Slate tool-call deltas before crossing the listener boundary", async () => {
    const received: unknown[] = [];
    const redactedSink = {
      async sendUpdate(_ctx: unknown, update: unknown) { received.push(update); },
    };
    const interaction = toUnredactedInteractionListener(redactedSink as never, PrivacyMode.NO_STORAGE);
    const handler = new InteractionHandler(interaction as never, {} as never, "invocation-delta");
    await handler.emitToolCallDelta(createContext(), "call-delta", {
      delta: { case: "editToolCallDelta", value: { streamContentDelta: "private patch" } },
    });

    assert.equal(received.length, 1);
    const update = received[0] as { kind?: string; privacyMode?: string; delta?: { kind?: string; textDelta?: unknown } };
    assert.equal(isSlateRedactedInteractionUpdate(update), true);
    assert.equal(update.kind, "tool-call-delta");
    assert.equal(update.privacyMode, PrivacyMode.NO_STORAGE);
    assert.equal(update.delta?.kind, "edit-content");
    assert.equal(isRedactedString(update.delta?.textDelta), true);
    if (isRedactedString(update.delta?.textDelta)) {
      assert.equal(update.delta.textDelta.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), "private patch");
    }
  });

  it("asks the surface to look again when a call it could not resolve is still pending", async () => {
    const unresolved: unknown[][] = [];
    const { listener: forwarding } = listener({ onSurfaceUnresolvedPending: (callId, update) => { unresolved.push([callId, update.name]); } });
    // A shell call, a read call and an await call are the ones a surface may not be able to resolve yet.
    await forwarding.sendUpdate({}, { message: { case: "toolCallStarted", value: { callId: "call-1", toolCall: shellCall } } });
    await forwarding.sendUpdate({}, { message: { case: "toolCallStarted", value: { callId: "call-2", toolCall: new ToolCall({ tool: { case: "readToolCall", value: { args: { path: "a.ts" } } as never } }) } } });
    await forwarding.sendUpdate({}, { message: { case: "toolCallStarted", value: { callId: "call-3", toolCall: new ToolCall({ tool: { case: "awaitToolCall", value: { args: {} } as never } }) } } });
    assert.deepEqual(unresolved, [["call-1", "shellToolCall"], ["call-2", "readToolCall"], ["call-3", "awaitToolCall"]]);
    // A call of another kind is left to the surface, and a completed one is not pending any more.
    await forwarding.sendUpdate({}, { message: { case: "toolCallStarted", value: { callId: "call-4", toolCall: new ToolCall({ tool: { case: "grepToolCall", value: { args: {} } as never } }) } } });
    await forwarding.sendUpdate({}, { message: { case: "toolCallCompleted", value: { callId: "call-5", toolCall: shellCall } } });
    assert.equal(unresolved.length, 3);
  });

  it("says a summary happened unless the turn was cancelled", async () => {
    let summaries = 0;
    const { listener: forwarding } = listener({ onSummaryLifecycle: () => { summaries += 1; } });
    await forwarding.sendUpdate({}, { message: { case: "summaryStarted", value: {} } });
    await forwarding.sendUpdate({}, { message: { case: "summaryCompleted", value: {} } });
    assert.equal(summaries, 2);
    await forwarding.sendUpdate({ canceled: true }, { message: { case: "summaryStarted", value: {} } });
    assert.equal(summaries, 2);
  });
});
