/**
 * The exclusive mutation lock, the inference protocol client, settling a turn, the connector auth watch,
 * the prompt acceptance ledger, the prompt collector and the MCP management tools.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCurrentAgentStoreMutationOwner } from "../../source/packages/agent-store-sync/exclusive-mutation-lock.ts";
import { ProtoPromptBuilder, ProtoPromptExecutor, ProtoSessionProvider } from "../../source/adapters/interop/chat-inference-proto/client.ts";
import { createTurnSettle, TranscriptAppendAfterCheckpointError } from "../../source/host/runner/turn-settle.ts";
import { CONNECTOR_AUTH_START_FAILURE_REASONS, CONNECTOR_AUTH_START_REFUSAL_REASONS, SlateMcpAuthWatchLifecycle } from "../../source/shared/node/mcp/mcp-auth-watch-lifecycle.ts";
import { MAX_DEGRADED_WINDOWS, MAX_RECORDS, NONCE_DIGEST_MISMATCH, PromptAcceptanceLedger } from "../../source/host/transcript/prompt-acceptance-ledger.ts";
import { createPromptCollectorGlue, SlateVideoAttachmentError } from "../../source/host/runner/prompt-collector-glue.ts";
import { renderAgentProfileUpdate } from "../../source/host/runner/slate-agent-profile-prompt.ts";
import { SLATE_HIDDEN_PROMPT_MARKER, SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER } from "../../source/host/runner/slate-prompt-markers.ts";
import { appendUserReplyReminder, buildAttachedFilesNote } from "../../source/host/runner/system-prompt.ts";
import { renderAutomationClearedStatusReminder } from "../../source/host/automations/automation.ts";
import { SelectedVideo as GeneratedSelectedVideo } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts";
import { UserMessage } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { buildServerConfigJson, MCP_AWAITING_SELECTION_MESSAGE, PLUGIN_QUERY_MIN_TOKEN_LENGTH } from "../../source/host/runner/tools/slate-mcp-management-tools.ts";

describe("a lock around one mutating operation", () => {
  it("reads who holds the claim", () => {
    assert.equal(typeof readCurrentAgentStoreMutationOwner, "function");
  });
});

describe("the client that speaks the inference protocol", () => {
  it("builds prompts, executes them and provides sessions", () => {
    assert.equal(typeof ProtoPromptBuilder, "function");
    assert.equal(typeof ProtoPromptExecutor, "function");
    assert.equal(typeof ProtoSessionProvider, "function");
  });
});

describe("settling a turn", () => {
  it("writes what a turn ended with, once", () => {
    assert.equal(typeof createTurnSettle, "function");
    assert.match(new TranscriptAppendAfterCheckpointError("late").message, /transcript append failed: late$/);
  });
});

describe("watching a connector's authorization", () => {
  it("names the reasons a start fails or is refused", () => {
    assert.equal(CONNECTOR_AUTH_START_FAILURE_REASONS.length, 2);
    assert.equal(CONNECTOR_AUTH_START_REFUSAL_REASONS.length, 6);
    assert.equal(typeof SlateMcpAuthWatchLifecycle, "function");
  });
});

describe("the ledger of what a prompt accepted", () => {
  it("bounds how much it keeps and how many degraded windows it allows", () => {
    assert.equal(MAX_RECORDS, 256);
    assert.equal(MAX_DEGRADED_WINDOWS, 8);
    assert.equal(NONCE_DIGEST_MISMATCH, "NONCE_DIGEST_MISMATCH");
    assert.equal(typeof PromptAcceptanceLedger, "function");
  });
});

describe("gathering a turn's prompt", () => {
  const host = (value: Record<string, unknown>) => value as never;
  const videoBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  const profileSnapshot = (identity: { readonly name: string; readonly description: string }) => ({
    version: 1 as const, profileSection: "profile", systemIdentity: identity, announcedIdentity: identity, compactionEpoch: 1,
  });
  const routine = (id: string, runs: unknown[] = []) => ({
    id, name: "Routine " + id, prompt: "p", trigger: {}, isEnabled: true, createdAt: 0, lastRunAt: null, raisedNotices: [],
    schedule: "", triggerDescription: "", nextRunAt: 1700000000000, runs, filePath: "/tmp/" + id,
  });

  it("is collected in one place, and a video it cannot attach says so", () => {
    assert.equal(typeof createPromptCollectorGlue, "function");
    assert.equal(new SlateVideoAttachmentError("too large").message, "too large");
  });

  it("says what the box and the desktop are to each kind of turn", () => {
    const plain = createPromptCollectorGlue(host({}));
    const defaultBox = plain.getRemoteBoxSection();
    assert.equal(defaultBox.startsWith("## Your box\n"), true);
    assert.equal(defaultBox.includes("CopyToBox"), true);
    assert.equal(plain.getComputerSection(), null);
    assert.equal(plain.spotlightEnabled(), true);
    assert.equal(createPromptCollectorGlue(host({ isSpotlightEnabled: () => false })).spotlightEnabled(), false);
    // A computerUse turn is told about the agent's own desktop, a browserUse turn about its browser.
    const computer = createPromptCollectorGlue(host({ isComputerUseSubagent: true }));
    assert.equal(computer.getRemoteBoxSection(), computer.getComputerUseRemoteBoxSection());
    assert.equal(computer.getRemoteBoxSection().includes("drive this agent's own desktop"), true);
    const browser = createPromptCollectorGlue(host({ isBrowserUseSubagent: true }));
    assert.equal(browser.getRemoteBoxSection(), browser.getBrowserUseRemoteBoxSection());
    assert.equal(browser.getRemoteBoxSection().includes("drive this agent's box browser"), true);
    // A turn that is both is told about the box as a computerUse turn.
    const both = createPromptCollectorGlue(host({ isComputerUseSubagent: true, isBrowserUseSubagent: true }));
    assert.equal(both.getRemoteBoxSection(), computer.getRemoteBoxSection());
  });

  it("tells a main agent about its desktop only when the box has one", () => {
    assert.equal(createPromptCollectorGlue(host({})).getComputerSection(), null);
    // With no subagent browser to offer, the main agent is pointed at the computerUse subagent.
    const notOffered = createPromptCollectorGlue(host({ remoteBoxHasDesktop: true })).getComputerSection() ?? "";
    assert.equal(notOffered.startsWith("## The box desktop"), true);
    assert.equal(notOffered.includes("Reach for the computerUse subagent for browsing"), true);
    // With a browserUse subagent offered, it is pointed at that first.
    const offered = createPromptCollectorGlue(host({ remoteBoxHasDesktop: true, isBrowserUseSubagentEnabled: () => true })).getComputerSection() ?? "";
    assert.equal(offered.includes("Reach for the"), true);
    assert.equal(offered.includes("subagent first for anything that happens in the browser"), true);
    // A subagent that is neither a desktop nor a browser turn gets no desktop section.
    assert.equal(createPromptCollectorGlue(host({ remoteBoxHasDesktop: true, isSubagentRunner: true })).getComputerSection(), null);
    const browserTurn = createPromptCollectorGlue(host({ remoteBoxHasDesktop: true, isBrowserUseSubagent: true })).getComputerSection() ?? "";
    assert.equal(browserTurn.startsWith("## Browser"), true);
    // A computerUse turn is told which display and CDP endpoint are its own when the runner knows them.
    const known = createPromptCollectorGlue(host({ remoteBoxHasDesktop: true, isComputerUseSubagent: true, resolveBoxBrowser: () => ({ display: ":9", cdpUrl: "ws://127.0.0.1:9231" }) })).getComputerSection() ?? "";
    assert.equal(known.includes(":9"), true);
    assert.equal(known.includes("ws://127.0.0.1:9231"), true);
    const unknown = createPromptCollectorGlue(host({ remoteBoxHasDesktop: true, isComputerUseSubagent: true })).getComputerSection() ?? "";
    assert.equal(unknown.includes("9222 plus that display number"), true);
  });

  it("gathers connector instructions for a main-agent turn only", async () => {
    const mcp = { getCustomInstructions: async () => new Map([["github", "Use it"]]) };
    const main = createPromptCollectorGlue(host({
      mcp, ctx: {},
      mcpConnectedServerNamesForTurn: () => ["github", "hex", "github"],
      mcpCustomInstructionsForTurn: () => new Map([["github", "Use it"], ["hex", ""]]),
      isMcpDiscoveryUnavailableForTurn: () => true,
    }));
    const section = main.getMcpCustomInstructionsSection() ?? "";
    assert.equal(section.includes("## Connector custom instructions"), true);
    assert.equal(section.includes("- github: Use it"), true);
    assert.equal(main.getMcpDiscoveryStatusSection()?.startsWith("<mcp_status>"), true);
    // A subagent turn gets neither section, and a turn whose discovery worked says nothing about it.
    const subagent = createPromptCollectorGlue(host({ isSubagentRunner: true, mcp, ctx: {}, isMcpDiscoveryUnavailableForTurn: () => true, mcpConnectedServerNamesForTurn: () => ["github"], mcpCustomInstructionsForTurn: () => new Map([["github", "Use it"]]) }));
    assert.equal(subagent.getMcpCustomInstructionsSection(), null);
    assert.equal(subagent.getMcpDiscoveryStatusSection(), null);
    assert.equal(createPromptCollectorGlue(host({ mcp, isMcpDiscoveryUnavailableForTurn: () => false })).getMcpDiscoveryStatusSection(), null);
    // Without an MCP host there is no section, and the instructions come back empty rather than failing.
    assert.equal(createPromptCollectorGlue(host({})).getMcpCustomInstructionsSection(), null);
    assert.equal((await main.resolveMcpCustomInstructions()).get("github"), "Use it");
    assert.equal((await subagent.resolveMcpCustomInstructions()).size, 0);
    const broken = createPromptCollectorGlue(host({ mcp: { getCustomInstructions: async () => { throw new Error("boom"); } }, ctx: {} }));
    assert.equal((await broken.resolveMcpCustomInstructions()).size, 0);
    let asked = false;
    const noContext = createPromptCollectorGlue(host({ mcp: { getCustomInstructions: async () => { asked = true; return new Map(); } } }));
    assert.equal((await noContext.resolveMcpCustomInstructions()).size, 0);
    assert.equal(asked, false);
  });

  it("carries the newest agent profile update, and not one the transcript already has", () => {
    const identityA = { name: "A", description: "1" };
    const identityB = { name: "B", description: "2" };
    const latestUpdate = renderAgentProfileUpdate(identityB);
    const glue = createPromptCollectorGlue(host({}));
    assert.equal(glue.getLatestAgentProfileUpdate([{ role: "system", content: "s" }]), null);
    assert.deepEqual(glue.getLatestAgentProfileUpdate([
      { role: "user", content: renderAgentProfileUpdate(identityA) },
      { role: "assistant", content: "x" },
      { role: "user", content: latestUpdate },
    ]), identityB);
    assert.deepEqual(glue.getLatestAgentProfileUpdate([{ role: "user", content: [{ text: "before" }, { text: latestUpdate }] }]), identityB);
    // A transcript that does not carry the current profile gets it appended, and the caller hears about it.
    const appended: unknown[] = [];
    const withProvider = createPromptCollectorGlue(host({ agentProfileProvider: () => identityB }));
    const messages = withProvider.appendProfileUpdateToHistory([{ role: "system", content: "s" }, { role: "user", content: "hello" }], profileSnapshot(identityA), (identity) => appended.push(identity));
    assert.equal(messages?.length, 3);
    assert.equal(messages?.[2]?.content, latestUpdate);
    assert.deepEqual(appended, [identityB]);
    // A transcript that already carries it, or has no system message, or a host with no profile: nothing appended.
    const unexpected: unknown[] = [];
    const recordUnexpected = () => { unexpected.push("bad"); };
    assert.equal(withProvider.appendProfileUpdateToHistory([{ role: "system", content: "s" }, { role: "user", content: latestUpdate }], profileSnapshot(identityB), recordUnexpected), undefined);
    assert.equal(withProvider.appendProfileUpdateToHistory([{ role: "user", content: "hello" }], profileSnapshot(identityA), recordUnexpected), undefined);
    assert.equal(createPromptCollectorGlue(host({})).appendProfileUpdateToHistory([{ role: "system", content: "s" }], profileSnapshot(identityA), recordUnexpected), undefined);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(appended, [identityB]);
  });

  it("says a routine status once per compaction epoch, and only as much as the panel shows", () => {
    const callback = createPromptCollectorGlue(host({ getAutomationStatusReminder: () => "R" }));
    assert.equal(callback.getAutomationStatusReminderForTurn(1), "R");
    callback.noteAutomationStatusReminder("R", 1);
    assert.equal(callback.getAutomationStatusReminderForTurn(1), null);
    assert.equal(callback.getAutomationStatusReminderForTurn(2), "R");
    callback.resetAutomationStatusReminder();
    assert.equal(callback.getAutomationStatusReminderForTurn(1), "R");
    // With a store the status is rendered from it, bounded to the panel's first hundred routines.
    const records = Array.from({ length: 150 }, (_, index) => routine("m" + index));
    const store = createPromptCollectorGlue(host({ automationStore: { getLocation: () => "/tmp/routines", list: () => records, listDefinitions: () => records }, requestContext: { resolve: () => ({ timeZone: "UTC" }) } }));
    const rendered = store.getAutomationStatusReminderForTurn(1) ?? "";
    assert.equal(rendered.includes("Routine m0"), true);
    assert.equal(rendered.includes("Routine m99"), true);
    assert.equal(rendered.includes("Routine m100"), false);
    // The store wins over the host's own rendering.
    const both = createPromptCollectorGlue(host({
      automationStore: { getLocation: () => "/tmp/routines", list: () => [routine("a1")] },
      requestContext: { resolve: () => ({ timeZone: "UTC" }) },
      getAutomationStatusReminder: () => "CALLBACK",
    }));
    assert.equal((both.getAutomationStatusReminderForTurn(1) ?? "").includes("Routine a1"), true);
    // The firing routine's still-running run is left out of its own status.
    const running = routine("a1", [{ id: "r1", trigger: "schedule", startedAt: 1700000000000, finishedAt: null, status: "running" }]);
    const firing = createPromptCollectorGlue(host({ automationStore: { getLocation: () => "/tmp/routines", list: () => [running] }, requestContext: { resolve: () => ({ timeZone: "UTC" }) } }));
    assert.equal((firing.getAutomationStatusReminderForTurn(1) ?? "").includes("running now"), true);
    assert.equal((firing.getAutomationStatusReminderForTurn(1, "a1") ?? "").includes("never run"), true);
    // A store with a location but no routines means they were cleared, which is said once after a status was told.
    const cleared = createPromptCollectorGlue(host({ automationStore: { getLocation: () => "/tmp/routines", list: () => [] }, requestContext: { resolve: () => ({ timeZone: "UTC" }) } }));
    cleared.noteAutomationStatusReminder("old", 1);
    const clearing = cleared.getAutomationStatusReminderForTurn(1) ?? "";
    assert.equal(clearing, renderAutomationClearedStatusReminder());
    cleared.noteAutomationStatusReminder(clearing, 1);
    assert.equal(cleared.getAutomationStatusReminderForTurn(1), null);
    assert.equal(cleared.getAutomationStatusReminderForTurn(2), clearing);
  });

  it("reads a box video only from inside the box workspace, and only when it is a video", async () => {
    const box = createPromptCollectorGlue(host({ remoteBox: { downloadFile: async () => videoBytes, uploadFile: async () => {} }, resolveBoxId: () => "box-1", remoteBoxHasDesktop: true }));
    assert.deepEqual(await box.readBoxVideoBytes("/workspace/videos/a.mp4"), videoBytes);
    assert.equal(await box.readBoxVideoBytes("/workspace/../etc/passwd"), null);
    assert.equal(await box.readBoxVideoBytes("/workspaceX/a.mp4"), null);
    assert.equal(await createPromptCollectorGlue(host({ remoteBoxHasDesktop: false })).readBoxVideoBytes("/workspace/a.mp4"), null);
    const notVideo = createPromptCollectorGlue(host({ remoteBox: { downloadFile: async () => new Uint8Array([1, 2, 3]), uploadFile: async () => {} }, resolveBoxId: () => "box-1", remoteBoxHasDesktop: true }));
    assert.equal(await notVideo.readBoxVideoBytes("/workspace/a.mp4"), null);
    const tooLarge = createPromptCollectorGlue(host({ remoteBox: { downloadFile: async () => ({ byteLength: 200 * 1024 * 1024 }), uploadFile: async () => {} }, resolveBoxId: () => "box-1", remoteBoxHasDesktop: true }));
    assert.equal(await tooLarge.readBoxVideoBytes("/workspace/a.mp4"), null);
    const failing = createPromptCollectorGlue(host({ remoteBox: { downloadFile: async () => { throw new Error("no"); }, uploadFile: async () => {} }, resolveBoxId: () => "box-1", remoteBoxHasDesktop: true }));
    assert.equal(await failing.readBoxVideoBytes("/workspace/a.mp4"), null);
    // A video of a few kilobytes is reviewed; only a huge one is refused.
    const largeVideo = new Uint8Array(2048);
    largeVideo.set([0, 0, 0, 24, 102, 116, 121, 112]);
    const largeBox = createPromptCollectorGlue(host({ remoteBox: { downloadFile: async () => largeVideo, uploadFile: async () => {} }, resolveBoxId: () => "box-1", remoteBoxHasDesktop: true }));
    assert.deepEqual(await largeBox.readBoxVideoBytes("/workspace/large.mp4"), largeVideo);
  });

  it("reads the bytes a subagent's video attachment needs, and says which one it could not read", async () => {
    const plainGlue = createPromptCollectorGlue(host({}));
    const videos = [{ path: " /workspace/a.mp4 ", filename: "a.mp4" }];
    const copied = await plainGlue.resolveSelectedVideosForTurn(videos);
    assert.deepEqual(copied, videos);
    assert.notEqual(copied, videos);
    // A subagent keeps the bytes it was given and reads the ones it lacks, from the host or from the box.
    const reading = createPromptCollectorGlue(host({ isSubagentRunner: true, readVideoAttachmentBytes: async () => videoBytes }));
    assert.deepEqual((await reading.resolveSelectedVideosForTurn([{ path: "/workspace/a.mp4", data: videoBytes }]))[0]?.data, videoBytes);
    assert.deepEqual((await reading.resolveSelectedVideosForTurn([{ path: " /workspace/a.mp4 " }]))[0]?.data, videoBytes);
    const fromBox = createPromptCollectorGlue(host({ isSubagentRunner: true, readVideoAttachmentBytes: async () => null, remoteBox: { downloadFile: async () => videoBytes, uploadFile: async () => {} }, resolveBoxId: () => "box-1", remoteBoxHasDesktop: true }));
    assert.deepEqual((await fromBox.resolveSelectedVideosForTurn([{ path: "/workspace/a.mp4" }]))[0]?.data, videoBytes);
    const missing = createPromptCollectorGlue(host({ isSubagentRunner: true }));
    await assert.rejects(() => missing.resolveSelectedVideosForTurn([{ path: " /workspace/a.mp4 ", filename: "a.mp4" }]), (error: unknown) => error instanceof SlateVideoAttachmentError && error.message === "Cannot read video attachment for review: a.mp4.");
    await assert.rejects(() => missing.resolveSelectedVideosForTurn([{ path: "", filename: "" }]), (error: unknown) => error instanceof SlateVideoAttachmentError && error.message === "Cannot read video attachment for review: .");
    await assert.rejects(() => missing.resolveSelectedVideosForTurn([{ path: " /workspace/a.mp4 " }]), (error: unknown) => error instanceof SlateVideoAttachmentError && error.message === "Cannot read video attachment for review: /workspace/a.mp4.");
  });

  it("assembles a turn's words, its notes and the questions it carries", async () => {
    const base = createPromptCollectorGlue(host({}));
    const plain = await base.assembleTurnAction({ trimmedPrompt: "hello", options: { messageId: " m9 " }, compactionEpoch: () => 7 });
    const plainMessage = plain.action.payload.message;
    assert.ok(plainMessage);
    assert.equal(plainMessage.text, "[m9]\nhello");
    assert.equal(plainMessage.messageId, " m9 ");
    assert.equal(plain.automationStatusReminder, null);
    assert.equal(plain.automationStatusCompactionEpoch, 7);
    // The reply note follows the address note, and the words follow both.
    const replying = await base.assembleTurnAction({ trimmedPrompt: "hello", options: { messageId: "m9", replyContext: { targetId: "t1", quote: "q" } }, compactionEpoch: () => 1 });
    assert.equal(replying.action.payload.message?.text, "[m9]\n[In reply to t1: \"q\"]\nhello");
    const quiet = await base.assembleTurnAction({ trimmedPrompt: "", options: { messageId: "m9" }, compactionEpoch: () => 1 });
    assert.equal(quiet.action.payload.message?.text, "[m9]");
    // The reply reminder is added only to a turn that asks for it and is not hidden.
    const reminded = await base.assembleTurnAction({ trimmedPrompt: "hello", options: { appendReplyReminder: true }, compactionEpoch: () => 1 });
    assert.equal(reminded.action.payload.message?.text, appendUserReplyReminder("hello"));
    const hiddenReminder = await base.assembleTurnAction({ trimmedPrompt: "hello", options: { appendReplyReminder: true, hidden: true }, compactionEpoch: () => 1 });
    assert.equal(hiddenReminder.action.payload.message?.text, SLATE_HIDDEN_PROMPT_MARKER + "hello");
    // A hidden turn is marked hidden, and says when a trusted automation woke it.
    const hiddenTrusted = await base.assembleTurnAction({ trimmedPrompt: "hello", options: { hidden: true, automationWake: { id: "a1", containsUntrustedEventText: false } }, compactionEpoch: () => 1 });
    assert.equal(hiddenTrusted.action.payload.message?.text, SLATE_HIDDEN_PROMPT_MARKER + SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER + "hello");
    const hiddenUntrusted = await base.assembleTurnAction({ trimmedPrompt: "hello", options: { hidden: true, automationWake: { id: "a1", containsUntrustedEventText: true } }, compactionEpoch: () => 1 });
    assert.equal(hiddenUntrusted.action.payload.message?.text, SLATE_HIDDEN_PROMPT_MARKER + "hello");
    // The routine status goes above the words when silence is allowed, below them otherwise.
    const routineGlue = createPromptCollectorGlue(host({ getAutomationStatusReminder: () => "<routine>" }));
    const below = await routineGlue.assembleTurnAction({ trimmedPrompt: "hello", options: {}, compactionEpoch: () => 1 });
    assert.equal(below.action.payload.message?.text, "hello\n\n<routine>");
    assert.equal(below.automationStatusReminder, "<routine>");
    const above = await routineGlue.assembleTurnAction({ trimmedPrompt: "hello", options: { isSilenceAllowed: true }, compactionEpoch: () => 1 });
    assert.equal(above.action.payload.message?.text, "<routine>\n\nhello");
    const only = await routineGlue.assembleTurnAction({ trimmedPrompt: "", options: { isSilenceAllowed: true }, compactionEpoch: () => 1 });
    assert.equal(only.action.payload.message?.text, "<routine>");
    // Rich text travels trimmed.
    const richOlder = await base.assembleTurnAction({ trimmedPrompt: "hello", options: { richText: "  hi  " }, compactionEpoch: () => 1 });
    assert.equal(richOlder.action.payload.message?.richText, "hi");
    // A profile update is placed the same way.
    const profile = await base.assembleTurnAction({ trimmedPrompt: "hello", options: {}, profileUpdateForTurn: { text: "PROFILE" }, compactionEpoch: () => 1 });
    assert.equal(profile.action.payload.message?.text, "hello\n\nPROFILE");
    // The questions the user left unanswered travel ahead of the message.
    const questions = await base.assembleTurnAction({ trimmedPrompt: "hello", options: { skippedQuestionPrompts: ["one", "two"], dismissedQuestionPrompts: ["two", "three"] }, compactionEpoch: () => 1 });
    assert.deepEqual(questions.action.payload.earlierMessages.map(message => message.text), ["Unanswered questions:\n- one\n- two\n- two\n- three"]);
    // Images and videos the turn carries become its selected context.
    const media = await base.assembleTurnAction({ trimmedPrompt: "hello", options: { selectedImages: [{ data: new Uint8Array([1]), path: "p", mimeType: "image/png" }], selectedVideos: [{ path: "/w/v.mp4", data: new Uint8Array([2]) }] }, compactionEpoch: () => 1 });
    assert.equal(media.action.payload.message?.selectedContext?.media.images.length, 1);
    assert.equal(media.action.payload.message?.selectedContext?.media.videos.length, 1);
    // Files are staged into the box when it can take them, and the note says where they went.
    const staging = createPromptCollectorGlue(host({ uploadAttachmentsIntoBox: async (paths: readonly string[]) => new Map(paths.map((filePath) => [filePath, "/workspace/uploads/" + filePath.split("/").pop()])), getRemoteBoxAvailable: () => true }));
    const staged = await staging.assembleTurnAction({ trimmedPrompt: "hello", options: { attachedFilePaths: ["/host/a.txt"], attachedFileSizes: new Map([["/host/a.txt", 12]]) }, compactionEpoch: () => 1 });
    assert.equal(staged.action.payload.message?.text, "hello\n\n" + buildAttachedFilesNote(["/host/a.txt"], new Map([["/host/a.txt", "/workspace/uploads/a.txt"]]), new Map([["/host/a.txt", 12]])));
    // A staging failure leaves the files on the user's computer only.
    const failingStage = createPromptCollectorGlue(host({ uploadAttachmentsIntoBox: async () => { throw new Error("no box"); }, getRemoteBoxAvailable: () => true }));
    const unstaged = await failingStage.assembleTurnAction({ trimmedPrompt: "hello", options: { attachedFilePaths: ["/host/a.txt"] }, compactionEpoch: () => 1 });
    assert.equal(unstaged.action.payload.message?.text.includes("on the user's computer"), true);
  });

  it("assembles the Slate turn action with Slate message values", async () => {
    const base = createPromptCollectorGlue(host({}));
    const plain = await base.assembleSlateTurnAction({ runCtx: {}, trimmedPrompt: "hello", options: {}, compactionEpoch: () => 7 });
    const plainValue = plain.action.payload;
    assert.equal(plainValue.message?.text, "hello");
    assert.equal(plainValue.message?.messageId, "");
    assert.equal(plainValue.message?.selectedContext, undefined);
    assert.equal(plainValue.earlierMessages.length, 0);
    assert.equal(plain.automationStatusCompactionEpoch, 7);
    // Rich text travels trimmed, images use the Slate selected-context state, and unanswered questions are added as one.
    const rich = await base.assembleSlateTurnAction({ runCtx: {}, trimmedPrompt: "hello", options: { richText: "  hi  ", selectedImages: [{ data: new Uint8Array([1]), path: "p", mimeType: "image/png" }], dismissedQuestionPrompts: ["q"] }, compactionEpoch: () => 1 });
    const richValue = rich.action.payload;
    assert.equal(richValue.message?.richText, "hi");
    assert.equal(richValue.message?.selectedContext?.media.images.length, 1);
    assert.equal(richValue.message?.selectedContext?.media.images[0]?.path, "p");
    assert.equal(richValue.message?.selectedContext?.media.images[0]?.mediaType, "image/png");
    assert.equal(richValue.earlierMessages.at(-1)?.text, "Unanswered questions:\n- q");
    const bare = await base.assembleSlateTurnAction({ runCtx: {}, trimmedPrompt: "", options: { selectedImages: [{ data: new Uint8Array([1]) }] }, compactionEpoch: () => 1 });
    const bareValue = bare.action.payload;
    assert.equal(bareValue.message?.selectedContext?.media.images[0]?.path, "");
    assert.equal(bareValue.message?.selectedContext?.media.images[0]?.mediaType, "");
    // The host's own collector is used, and the tracing phase names the collection.
    const phases: string[] = [];
    const collecting = createPromptCollectorGlue(host({ collectGeneratedPrependUserMessages: async () => [new UserMessage({ text: "earlier", messageId: "m1" })], traceSendPhase: async (ctx: unknown, name: string, operation: () => Promise<UserMessage[]>) => { phases.push(name); return operation(); } }));
    const collected = await collecting.assembleSlateTurnAction({ runCtx: { ok: true }, trimmedPrompt: "hello", options: {}, compactionEpoch: () => 1 });
    const collectedValue = collected.action.payload;
    assert.equal(collectedValue.earlierMessages.length, 1);
    assert.equal(collectedValue.earlierMessages[0]?.text, "earlier");
    assert.deepEqual(phases, ["collectPrependUserMessages"]);
    // A shell-watch host is asked instead of the collector, even with no recent messages to read.
    let collectorCalled = false;
    const watching = createPromptCollectorGlue(host({ shellWatchHost: () => ({}), collectGeneratedPrependUserMessages: async () => { collectorCalled = true; return [new UserMessage({ text: "no" })]; } }));
    const watched = await watching.assembleSlateTurnAction({ runCtx: {}, trimmedPrompt: "hello", options: {}, compactionEpoch: () => 1 });
    assert.equal(watched.action.payload.earlierMessages.length, 0);
    assert.equal(collectorCalled, false);
    // A video with no bytes and no way to read them says which attachment failed.
    const missingVideo = createPromptCollectorGlue(host({ isSubagentRunner: true }));
    await assert.rejects(() => missingVideo.assembleSlateTurnAction({ runCtx: {}, trimmedPrompt: "hello", options: { selectedVideos: [new GeneratedSelectedVideo({ uuid: "u1", path: " /workspace/v.mp4 ", filename: "" })] }, compactionEpoch: () => 1 }), (error: unknown) => error instanceof SlateVideoAttachmentError && error.message === "Cannot read video attachment for review: /workspace/v.mp4.");
    // A video that already has bytes travels as it is.
    const ready = await createPromptCollectorGlue(host({ isSubagentRunner: true })).assembleSlateTurnAction({ runCtx: {}, trimmedPrompt: "hello", options: { selectedVideos: [new GeneratedSelectedVideo({ uuid: "u1", path: "/workspace/v.mp4", dataOrBlobId: { case: "data", value: new Uint8Array([1]) } })] }, compactionEpoch: () => 1 });
    assert.equal(ready.action.payload.message?.selectedContext?.media.videos.length, 1);
  });
});

describe("the tools an agent manages its MCP servers with", () => {
  it("names the minimum a plugin query may be and what to say while waiting", () => {
    assert.equal(PLUGIN_QUERY_MIN_TOKEN_LENGTH, 3);
    assert.equal(MCP_AWAITING_SELECTION_MESSAGE.length > 0, true);
    assert.equal(typeof buildServerConfigJson, "function");
  });
});
