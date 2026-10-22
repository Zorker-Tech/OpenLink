/**
 * The host's runtime pieces, third group: what a box can do, the OAuth completion that resumes an agent,
 * the session cards and projections, the shared-room state, the trigger model, transfers, manifests and
 * the small services around them.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { boxAgentWindowIndex, boxApplyEnvironment, boxDescription, boxIsAvailable, boxIsPreparing, boxLoadMcpServers, boxMaxWindows, boxMcpResourceAccessor, boxSupportsMultiWindow, boxTerminalsFolder } from "../../source/host/boxes/box-capabilities.ts";
import { HostMcpAuthCompletion, type HostMcpAuthCompletionEvent } from "../../source/host/mcp/host-mcp-auth-completion.ts";
import { fetchedManagedSkillToSlateSkill } from "../../source/host/extensions/managed-setup/slate-managed-skills.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { expirePendingAutoReviewApprovalEntries, expirePendingLocalToolPermissionAskEntries } from "../../source/host/extensions/session/pending-card-sweeps.ts";
import { getSummaryUpdatedAt, getUpdatedAtFromStats, seedActivityFromMtime } from "../../source/host/extensions/session/session-projection.ts";
import { bumpDbWriteGeneration, DB_BUSY_TIMEOUT_MS, deleteSlateAgentDbWriteGeneration, getSlateAgentDbWriteGeneration, hasLiveSlateAgentDbHandle, liveDbHandleCount, registerLiveDbHandle, releaseLiveDbHandle, SQLITE_DB_SIDECAR_SUFFIXES } from "../../source/host/storage/store-db.ts";
import { selectSlateExperimentTurnModel, selectSlateModelExperimentModel, SLATE_AUTOMATION_REQUEST_SOURCE } from "../../source/host/extensions/inference/slate-model-experiment.ts";
import { pinSessionDiagnosticsReporter, reportSessionDiagnostic, type SessionDiagnostic } from "../../source/host/extensions/session/session-diagnostics.ts";
import { createInMemoryXuserTurnDedupe, SlateXuserTurnDedupeStore, XUSER_TURN_DEDUPE_TTL_MS } from "../../source/host/rooms/xuser-turn-dedupe-store.ts";
import { loadSelectedImageInputs } from "../../source/host/selected-image-inputs.ts";
import { assertMembersAreNotGroups, buildGroupMemberSystemPrompt, buildGroupRedriveNote, buildGroupTurnPrompt, describeGroup, formatGroupChatTag, formatGroupHistory, formatGroupLine, GROUP_CHAT_TAG_PREFIX, GROUP_CONFIG_VERSION, GROUP_MAX_MEMBER_TURNS, GROUP_MAX_MESSAGES_PER_TURN, GROUP_MAX_ROUNDS, GROUP_PROMPT_HISTORY_LIMIT, groupDisplayName, isGroupTurnPromptText, isPassContent, isPotentialPassPrefix, isSameMemberSet, memberMentionHandles, messagesSinceMemberLastSpoke, orderRoundSpeakers, parseGroupMentions, resolveResponders, SHARED_ROOM_HISTORY_LIMIT, SLATE_HIDDEN_PROMPT_MARKER, SlateGroupNestingError, type GroupMessage } from "../../source/host/groups/group-chat.ts";
import { createProductionRunnerContext } from "../../source/host/runner-context-production-provider.ts";
import { BROWSER_USE_SUBAGENT_DESCRIPTION, BROWSER_USE_SUBAGENT_TYPE, createSlateBrowserUseSubagentConfig, isBrowserUseSubagentType } from "../../source/host/runner/tools/slate-browser-use-subagent.ts";
import { hostEventBusTelemetry, HOST_EVENT_BUS_EVENT } from "../../source/host/telemetry/host-event-bus-telemetry.ts";
import { createInMemoryXuserPendingDepartures, departureKey, parseDepartureFile, SLATE_XUSER_PENDING_DEPARTURE_FILE_NAME, SlateXuserPendingDepartureStore } from "../../source/host/rooms/xuser-pending-departure-store.ts";
import { SlateXuserStateReconcile, type XuserRoom, type XuserStateReconcileHost } from "../../source/host/rooms/xuser-state-reconcile.ts";
import { adoptRemoteParent, beginGatewayCommandTrace, beginSendTrace, setHostTraceFactory, SLATE_TURN_ROOT_SPAN_NAME } from "../../source/host/send-trace-host.ts";
import { buildTriggerEventContextBlock, describeTriggerEvent, githubListenerMatches, listenerMatchesEvent, parseStoredTrigger, serializeStoredTrigger, slackListenerMatches, slackScopeMatches, triggerIdentity, triggerMatchesEvent } from "../../source/host/automations/automation-trigger.ts";
import { BoxFileUnreadableError, BOX_PATH_ROOTS, DEFAULT_BOX_TRANSFER_MAX_BYTES, isBoxRootPath, resolveBoxWorkspacePath, SLATE_BOX_UPLOADS_DIR, SLATE_BOX_WORKSPACE_ROOT } from "../../source/host/boxes/box-transfer.ts";
import { BOX_STORE_MANIFEST_VERSION, boxStoreManifestEntriesEqual, isBoxStoreManifestFileEntry, isBoxStoreManifestSymlinkEntry, isSymlinkManifestValue, manifestSchema } from "../../source/host/boxes/box-store-sync/box-store-manifest-format.ts";
import { buildCloudAgentRequestedModel, buildRepoFromRemote, normalizeRepoReference, resolveCloudAgentEnvironmentFields, resolveLaunchRepoReference, sanitizeRemoteUrl, sanitizeRemoteUrlForHttpUrl } from "../../source/host/cloud-agents/cloud-agent-request-composition.ts";
import { createUaTokenKillSwitchReconciler, UA_TOKEN_DISABLED_MARKER_PATH } from "../../source/host/extensions/browser-ua/ua-token-kill-switch-service.ts";
import { clearHostBundleVersionCache, fetchHostBundleTarball, fetchLatestHostBundleVersion, HOST_BUNDLE_PREFIX, hostBundleBaseUrl, hostBundleTarballUrl, HOST_BUNDLE_REGION, HOST_BUNDLE_BUCKET, resolveHostBundleSource, SlateHostBundleSourceError } from "../../source/host/extensions/host-upgrade/host-bundle-source.ts";
import { getLoggerBackend } from "../../source/packages/context/logging.ts";
import { SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION } from "../../source/shared/node/experiments/slate-model-experiment.ts";
import type { SlateAgentModelSelection } from "../../source/shared/agents/slate-agent-model.ts";
import { BoxEnvironmentSyncUnsupportedError, BoxMcpUnsupportedError } from "../../source/host/ports/box.ts";
import { BOX_MCP_UNSUPPORTED_MESSAGE } from "../../source/host/boxes/box-mcp.ts";
import type { Context } from "../../source/packages/context/context.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-runtime-3-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

const context = {} as Context;

describe("what a box can do", () => {
  it("answers for a box that says nothing, and asks the box that says something", async () => {
    assert.equal(boxMaxWindows({}), 1);
    assert.equal(boxSupportsMultiWindow({}), false);
    assert.equal(boxSupportsMultiWindow({ maxWindows: () => 3 }), true);
    assert.equal(boxAgentWindowIndex({}, "a1"), undefined);
    assert.equal(boxAgentWindowIndex({ getAgentWindowIndex: () => 2 }, "a1"), 2);
    assert.equal(boxTerminalsFolder({}), undefined);
    assert.equal(await boxIsAvailable({}), true);
    assert.equal(await boxIsAvailable({ isAvailable: async () => false }), false);
    assert.equal(boxIsPreparing({}, "a1"), false);
    assert.equal(boxDescription({}), undefined);
  });

  it("refuses the capabilities a box does not have", async () => {
    await assert.rejects(() => boxApplyEnvironment({}, context, {}), BoxEnvironmentSyncUnsupportedError);
    await assert.rejects(() => boxLoadMcpServers({}, context, "{}"), BoxMcpUnsupportedError);
    await assert.rejects(() => boxMcpResourceAccessor({}, context), BoxMcpUnsupportedError);
    assert.match(BOX_MCP_UNSUPPORTED_MESSAGE, /^Slate's computer is running an older image/);
    const calls: unknown[] = [];
    await boxApplyEnvironment({ applyEnvironment: async (_ctx, update) => { calls.push(update); } }, context, { env: {} });
    assert.deepEqual(await boxLoadMcpServers({ loadMcpServers: async () => ({ ok: true }) }, context, "{}"), { ok: true });
    assert.deepEqual(calls, [{ env: {} }]);
  });
});

describe("an OAuth flow that finished somewhere else", () => {
  const completion: HostMcpAuthCompletionEvent = { serverId: "srv-1", serverName: "linear", accountKey: "acct", outcome: "authorized" };

  function harness(options: { watchAgentId?: string | null } = {}) {
    const resumed: string[] = [];
    const restarts: string[] = [];
    const noted: string[] = [];
    const service = new HostMcpAuthCompletion({
      getMcp: () => ({
        noteAuthCompletedElsewhere: (serverId, accountKey) => { noted.push(`${serverId}/${accountKey}`); return options.watchAgentId ?? null; },
        management: { restart: async () => { restarts.push("restart"); } },
      }),
      getTranscript: () => ({ resumeAfterMcpAuth: async (agentId) => { resumed.push(agentId); } }),
    });
    return { service, resumed, restarts, noted };
  }

  it("tells the servers, then resumes the agent that was waiting", async () => {
    const { service, resumed, noted } = harness();
    service.registerConnectCard({ agentId: "a1", connector: "linear" });
    service.resolve(completion);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(noted, ["srv-1/acct"]);
    assert.deepEqual(resumed, ["a1"]);
  });

  it("resumes the requesting agent over the watched one, and nothing when the flow was cancelled", async () => {
    const { service, resumed } = harness({ watchAgentId: "watched" });
    service.resolve({ ...completion, requestingAgentId: "a2" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resumed, ["a2"]);
    service.resolve({ ...completion, outcome: "cancelled" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resumed, ["a2"]);
  });

  it("restarts the management side before resolving a flow that came from the desktop", async () => {
    const { service, resumed, restarts } = harness();
    service.registerConnectCard({ agentId: "a3", connector: "linear" });
    await service.resolveDesktop(completion);
    assert.deepEqual(restarts, ["restart"]);
    assert.deepEqual(resumed, ["a3"]);
  });
});

describe("a skill the platform manages", () => {
  it("keeps only what an agent can read, and names it after the id when it has no name", () => {
    assert.equal(fetchedManagedSkillToSlateSkill({ id: "review", description: "d", content: "Do it.", enabled: false }), null);
    assert.equal(fetchedManagedSkillToSlateSkill({ id: "../escape", description: "d", content: "Do it.", enabled: true }), null);
    assert.equal(fetchedManagedSkillToSlateSkill({ id: "review", description: "d", content: "   ", enabled: true }), null);
    const named = fetchedManagedSkillToSlateSkill({ id: "review", description: "d", content: "---\nname: Reviewer\n---\nDo it.", enabled: true });
    assert.equal(named?.name, "Reviewer");
    const unnamed = fetchedManagedSkillToSlateSkill({ id: "review", description: "d", content: "Do it.", enabled: true });
    assert.equal(unnamed?.id, "review");
    assert.equal(unnamed?.name, "review");
    assert.equal(unnamed?.body, "Do it.");
  });
});

describe("the ids every extension registers under", () => {
  it("are all set, and no two extensions share one", () => {
    const ids = Object.values(HostExtensions);
    assert.equal(ids.length > 20, true);
    assert.equal(ids.every((id) => id.length > 0), true);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(HostExtensions.BoxStoreSync, "box-store-sync");
    assert.equal(HostExtensions.Mcp, "mcp");
  });
});

describe("the cards that were still pending when their session ended", () => {
  function db(entries: Array<Record<string, unknown>>) {
    const updates: Array<{ id: string; entry: Record<string, unknown> }> = [];
    return {
      updates,
      getTranscriptEntries: () => entries,
      updateTranscriptEntry: (id: string, update: (entry: Record<string, unknown>) => Record<string, unknown>) => {
        const entry = entries.find((candidate) => candidate.id === id);
        if (entry != null) updates.push({ id, entry: update(entry) });
      },
    };
  }

  it("expires a pending approval, and only the one a caller names", () => {
    const store = db([
      { id: "e1", kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "r1", status: "pending" } } },
      { id: "e2", kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "r2", status: "pending" } } },
      { id: "e3", kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "r3", status: "approved" } } },
      { id: "e4", kind: "notice", message: { type: "auto-review-approval", approval: { requestId: "r4", status: "pending" } } },
    ]);
    assert.deepEqual(expirePendingAutoReviewApprovalEntries(store), ["r1", "r2"]);
    assert.deepEqual(expirePendingAutoReviewApprovalEntries(store, "r9"), []);
    assert.equal(store.updates.length, 2);
  });

  it("expires a pending permission ask, honouring how old it has to be", () => {
    const store = db([
      { id: "e1", kind: "send-message", timestampMs: 10, message: { type: "local-tool-permission", ask: { requestId: "r1", status: "pending" } } },
      { id: "e2", kind: "send-message", timestampMs: 100, message: { type: "local-tool-permission", ask: { requestId: "r2", status: "pending" } } },
    ]);
    assert.deepEqual(expirePendingLocalToolPermissionAskEntries(store, { ifPendingBeforeMs: 50 }), ["r1"]);
    assert.deepEqual(expirePendingLocalToolPermissionAskEntries(store, { onlyRequestId: "r3" }), []);
    assert.deepEqual(store.updates.map((update) => update.id), ["e1"]);
  });
});

describe("what a session looks like from outside", () => {
  it("takes the later of when it was created and when it was last touched", () => {
    assert.equal(getUpdatedAtFromStats({ createdAt: 5 }, { mtimeMs: 9.7 }), 9);
    assert.equal(getUpdatedAtFromStats({ createdAt: 12 }, { mtimeMs: 9.7 }), 12);
    assert.equal(getUpdatedAtFromStats({ createdAt: 12 }), 12);
    assert.equal(getSummaryUpdatedAt({ createdAt: 4 }, { lastActivityAt: 8 }), 8);
  });

  it("seeds activity from the transcript's own time, only once and only when there is something in it", () => {
    const marks: number[] = [];
    const make = (state: { lastActivityAt: number }, root: Uint8Array | number | undefined) => ({
      getUnreadState: () => state,
      get: (key: string) => (key === "latestRootBlobId" ? root ?? 0 : key === "createdAt" ? 7 : 0),
      markActivity: (at: number) => { marks.push(at); },
    });
    seedActivityFromMtime(make({ lastActivityAt: 3 }, new Uint8Array([1])), "a1", { mtimeMs: 50 });
    assert.deepEqual(marks, []);
    seedActivityFromMtime(make({ lastActivityAt: 0 }, undefined), "a1", { mtimeMs: 50 });
    assert.deepEqual(marks, []);
    seedActivityFromMtime(make({ lastActivityAt: 0 }, new Uint8Array([1])), "a1", { mtimeMs: 50 });
    assert.deepEqual(marks, [50]);
  });
});

describe("the database a store keeps its state in", () => {
  it("counts live handles and bumps a write generation per file", () => {
    const path = join(scratch, "store", "agents.db");
    assert.equal(DB_BUSY_TIMEOUT_MS, 5_000);
    assert.deepEqual([...SQLITE_DB_SIDECAR_SUFFIXES], ["-wal", "-shm", "-journal"]);
    assert.equal(getSlateAgentDbWriteGeneration(path), 0);
    bumpDbWriteGeneration(path);
    bumpDbWriteGeneration(path);
    assert.equal(getSlateAgentDbWriteGeneration(path), 2);
    deleteSlateAgentDbWriteGeneration(path);
    assert.equal(getSlateAgentDbWriteGeneration(path), 0);
    assert.equal(hasLiveSlateAgentDbHandle(path), false);
    registerLiveDbHandle(path);
    registerLiveDbHandle(path);
    assert.equal(liveDbHandleCount(path), 2);
    assert.equal(hasLiveSlateAgentDbHandle(path), true);
    releaseLiveDbHandle(path);
    releaseLiveDbHandle(path);
    assert.equal(hasLiveSlateAgentDbHandle(path), false);
  });
});

describe("which model an experiment arm puts a turn on", () => {
  const configured: SlateAgentModelSelection = { modelId: "chosen", maxMode: false, parameters: [] };

  it("changes nothing while it is off or in control, and keeps the user's choice in treatment", () => {
    assert.equal(selectSlateModelExperimentModel(undefined, undefined, configured), undefined);
    assert.equal(selectSlateModelExperimentModel({ active: true, arm: "control" }, undefined, configured), SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION);
    assert.equal(selectSlateModelExperimentModel({ active: true, arm: "treatment" }, undefined, configured), configured);
    assert.equal(selectSlateModelExperimentModel({ active: true, arm: "treatment" }, undefined, undefined), SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION);
  });

  it("reads the model a turn's source would have used", () => {
    assert.equal(selectSlateExperimentTurnModel({ state: null, readConfiguredDefaultModel: () => configured, readConfiguredAutomationsModel: () => undefined }), undefined);
    assert.equal(selectSlateExperimentTurnModel({ state: { active: true, arm: "treatment" }, readConfiguredDefaultModel: () => configured, readConfiguredAutomationsModel: () => undefined }), configured);
    const automations = { modelId: "automations", maxMode: false, parameters: [] };
    assert.equal(
      selectSlateExperimentTurnModel({ state: { active: true, arm: "treatment" }, requestSource: SLATE_AUTOMATION_REQUEST_SOURCE, readConfiguredDefaultModel: () => configured, readConfiguredAutomationsModel: () => automations }),
      automations,
    );
    assert.equal(SLATE_AUTOMATION_REQUEST_SOURCE, "automation");
  });
});

describe("where a session's diagnostics go", () => {
  it("goes to the reporter that was pinned, and nowhere when none is", () => {
    const seen: SessionDiagnostic[] = [];
    pinSessionDiagnosticsReporter((report) => { seen.push(report); });
    reportSessionDiagnostic({ family: "box", kind: "hydrate" });
    pinSessionDiagnosticsReporter(null);
    reportSessionDiagnostic({ family: "box", kind: "hydrate" });
    assert.deepEqual(seen, [{ family: "box", kind: "hydrate" }]);
  });

  it("hands the reporter the very diagnostic it was given, once per report, and ignores its answer", () => {
    const seen: SessionDiagnostic[] = [];
    const arities: number[] = [];
    pinSessionDiagnosticsReporter((...args: [SessionDiagnostic]) => { arities.push(args.length); seen.push(args[0]); return "ignored"; });
    try {
      const diagnostic = { family: "session", kind: "roster", detail: { id: "a1" } };
      assert.equal(reportSessionDiagnostic(diagnostic), undefined, "reporting answers nothing");
      assert.equal(seen.length, 1);
      assert.deepEqual(arities, [1], "the reporter is handed exactly the diagnostic");
      assert.equal(seen[0] === diagnostic, true, "the object is handed over, not a copy");
      reportSessionDiagnostic({ family: "box", kind: "hydrate" });
      assert.deepEqual(seen.map((entry) => entry.family), ["session", "box"]);
    } finally {
      pinSessionDiagnosticsReporter(null);
    }
  });

  it("replaces the pinned reporter, and pins nothing again when it is given null", () => {
    const first: SessionDiagnostic[] = [];
    const second: SessionDiagnostic[] = [];
    try {
      pinSessionDiagnosticsReporter((report) => { first.push(report); });
      pinSessionDiagnosticsReporter((report) => { second.push(report); });
      reportSessionDiagnostic({ family: "box", kind: "hydrate" });
      assert.deepEqual([first.length, second.length], [0, 1], "only the latest reporter is used");
      pinSessionDiagnosticsReporter(null);
      reportSessionDiagnostic({ family: "box", kind: "hydrate" });
      assert.deepEqual([first.length, second.length], [0, 1]);
    } finally {
      pinSessionDiagnosticsReporter(null);
    }
  });

  it("lets a failing reporter fail the report", () => {
    pinSessionDiagnosticsReporter(() => { throw new Error("diagnostics are down"); });
    try {
      assert.throws(() => reportSessionDiagnostic({ family: "box", kind: "hydrate" }), /diagnostics are down/);
    } finally {
      pinSessionDiagnosticsReporter(null);
    }
  });
});

describe("remembering the turns another computer already delivered", () => {
  it("counts the first sighting of a nonce as new, and forgets it when its time is up", () => {
    let nowMs = 1_000;
    const root = join(scratch, "dedupe");
    const store = new SlateXuserTurnDedupeStore(root, 100, () => nowMs);
    assert.equal(store.markSeenIfNew(""), false);
    assert.equal(store.markSeenIfNew("nonce-1"), true);
    assert.equal(store.markSeenIfNew("nonce-1"), false);
    const written = JSON.parse(readFileSync(store.filePath, "utf8")) as { version: number; seen: Array<{ nonce: string }> };
    assert.equal(written.version, 1);
    assert.deepEqual(written.seen.map((entry) => entry.nonce), ["nonce-1"]);
    const reopened = new SlateXuserTurnDedupeStore(root, 100, () => nowMs);
    assert.equal(reopened.markSeenIfNew("nonce-1"), false);
    nowMs += 101;
    assert.equal(reopened.markSeenIfNew("nonce-1"), true);
    assert.equal(XUSER_TURN_DEDUPE_TTL_MS, 3 * 24 * 60 * 60 * 1_000);
  });

  it("treats a file it cannot read as nothing remembered, and has an in-memory twin", () => {
    const root = join(scratch, "dedupe-broken");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "host-xuser-turn-nonces.json"), "{not json");
    const store = new SlateXuserTurnDedupeStore(root, 100, () => 5);
    assert.equal(store.markSeenIfNew("nonce-2"), true);
    const memory = createInMemoryXuserTurnDedupe(100, () => 0);
    assert.equal(memory.markSeenIfNew("n"), true);
    assert.equal(memory.markSeenIfNew("n"), false);
  });
});

describe("the images a user attached", () => {
  it("reads what it can and leaves out what it cannot", async () => {
    const good = join(scratch, "shot.png");
    writeFileSync(good, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.deepEqual(await loadSelectedImageInputs([]), []);
    const loaded = await loadSelectedImageInputs([good, join(scratch, "missing.png")]);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.path, good);
    assert.equal(loaded[0]?.mimeType, "image/png");
    assert.equal(loaded[0]?.data.byteLength, 4);
  });
});

describe("a conversation between the members of a group", () => {
  const members = [
    { id: "a1", name: "Ada Lovelace", description: "" },
    { id: "a2", name: "Grace Hopper", description: "" },
    { id: "a3", name: "Alan Turing", description: "" },
  ];

  it("rotates who speaks first, and compares member sets without order", () => {
    assert.equal(GROUP_CONFIG_VERSION, 1);
    assert.equal(GROUP_MAX_MEMBER_TURNS, 10);
    assert.equal(GROUP_MAX_ROUNDS, 3);
    assert.equal(GROUP_PROMPT_HISTORY_LIMIT, 24);
    assert.equal(GROUP_MAX_MESSAGES_PER_TURN, 2);
    assert.equal(SHARED_ROOM_HISTORY_LIMIT, 24);
    assert.equal(GROUP_CHAT_TAG_PREFIX, "[Group chat: ");
    assert.equal(SLATE_HIDDEN_PROMPT_MARKER, "[SLATE_HIDDEN_PROMPT]");
    assert.deepEqual(orderRoundSpeakers(["a", "b", "c"], 0), ["a", "b", "c"]);
    assert.deepEqual(orderRoundSpeakers(["a", "b", "c"], 1), ["b", "c", "a"]);
    assert.deepEqual(orderRoundSpeakers(["a", "b", "c"], 4), ["b", "c", "a"]);
    assert.deepEqual(orderRoundSpeakers(["a", "b", "c"], -1), ["c", "a", "b"], "a negative round counts back from the end");
    assert.deepEqual(orderRoundSpeakers([], 3), []);
    assert.equal(isSameMemberSet(["a", "b"], ["b", "a"]), true);
    assert.equal(isSameMemberSet(["a"], ["a", "b"]), false);
    assert.equal(isSameMemberSet(["x", "y"], ["x", "z"]), false);
    assert.equal(isSameMemberSet(["x", "x"], ["x", "y"]), false, "a repeated name does not stand in for another name");
    assert.equal(isSameMemberSet(["x"], ["x", "x"]), false, "a repeated name does not make a longer list the same list");
  });

  it("recognizes a mention, and everyone", () => {
    assert.deepEqual(memberMentionHandles("  Ada Lovelace "), ["ada lovelace", "adalovelace", "ada"]);
    assert.deepEqual(memberMentionHandles("   "), []);
    assert.deepEqual(memberMentionHandles("Ada\tLovelace"), ["ada\tlovelace", "adalovelace", "ada"], "any whitespace collapses into the joined handle");
    assert.deepEqual(parseGroupMentions("@Ada ask grace about it", members).memberIds, ["a1"]);
    assert.deepEqual(parseGroupMentions("@Grace Hopper and @Alan Turing please", members).memberIds, ["a2", "a3"]);
    assert.deepEqual(parseGroupMentions("email ada@example.com", members).memberIds, []);
    assert.deepEqual(parseGroupMentions("write to alan@example.com", members).memberIds, []);
    assert.deepEqual(parseGroupMentions("@adalovelace hello", members).memberIds, ["a1"]);
    assert.equal(parseGroupMentions("@everyone hello", members).isEveryone, true);
    assert.equal(parseGroupMentions("nothing for you", members).isEveryone, false);
  });

  it("sends a message to everyone, to the people mentioned, or to whoever was addressed", () => {
    const history: GroupMessage[] = [{ speaker: { kind: "user" }, content: "hello room" }];
    assert.deepEqual(resolveResponders(members, history).map((member) => member.id), ["a1", "a2", "a3"]);
    const mentioned: GroupMessage[] = [...history, { speaker: { kind: "user" }, content: "@Grace Hopper take this" }];
    assert.deepEqual(resolveResponders(members, mentioned).map((member) => member.id), ["a2"]);
    const afterReply: GroupMessage[] = [...mentioned, { speaker: { kind: "member", id: "a2", name: "Grace Hopper" }, content: "on it" }];
    assert.deepEqual(resolveResponders(members, afterReply).map((member) => member.id), ["a2"]);
    assert.deepEqual(resolveResponders(members, [{ speaker: { kind: "user" }, content: "@everyone" }]).map((member) => member.id), ["a1", "a2", "a3"]);
  });

  it("knows what passing looks like, and how a room line reads to one member", () => {
    assert.equal(isPassContent("(pass)"), true);
    assert.equal(isPassContent("  "), true);
    assert.equal(isPassContent("PASS."), true);
    assert.equal(isPassContent("here is my answer"), false);
    assert.equal(formatGroupLine({ speaker: { kind: "user", name: "Kee" }, content: "hi" }, "a1"), "Kee (user): hi");
    assert.equal(formatGroupLine({ speaker: { kind: "user" }, content: "hi" }, "a1"), "User: hi");
    assert.equal(formatGroupLine({ speaker: { kind: "member", id: "a1", name: "Ada" }, content: "hi" }, "a1"), "Ada (you): hi");
    assert.equal(formatGroupLine({ speaker: { kind: "member", id: "a2", name: "Grace" }, content: "hi" }, "a1"), "Grace: hi");
    assert.equal(formatGroupHistory([], "a1"), "(no messages yet)");
    assert.equal(formatGroupHistory([{ speaker: { kind: "member", id: "a2", name: "Grace" }, content: "hi" }], "a1"), "Grace: hi");
  });

  it("gives a member only what was said since it last spoke, and tags a turn as a group turn", () => {
    const history: GroupMessage[] = [
      { speaker: { kind: "user" }, content: "one" },
      { speaker: { kind: "member", id: "a2", name: "Grace" }, content: "two" },
      { speaker: { kind: "member", id: "a1", name: "Ada" }, content: "three" },
      { speaker: { kind: "user" }, content: "four" },
    ];
    assert.deepEqual(messagesSinceMemberLastSpoke(history, "a1").map((message) => message.content), ["four"]);
    assert.deepEqual(messagesSinceMemberLastSpoke(history, "a9").map((message) => message.content), ["one", "two", "three", "four"]);
    assert.equal(isGroupTurnPromptText("[SLATE_HIDDEN_PROMPT][Group chat: \"Room\"] hello"), true);
    assert.equal(isGroupTurnPromptText("just a message"), false);
    assert.equal(groupDisplayName({ name: "  ", description: "" }), "the group");
    assert.equal(formatGroupChatTag({ name: "Room", description: "" }, [{ name: "Ada" }]), '[Group chat: "Room" - with Ada]');
  });

  it("refuses a group inside a group", () => {
    assert.throws(
      () => assertMembersAreNotGroups(["a1", "g1", "g2", "g1"], (id) => id.startsWith("g")),
      (error: unknown) => error instanceof SlateGroupNestingError && error.nestedGroupIds.length === 2 && /group chats/.test(error.message),
    );
    assert.doesNotThrow(() => assertMembersAreNotGroups(["a1"], () => false));
  });

  it("reads a mention only as a whole word, once per member, in the order the members are listed", () => {
    assert.deepEqual(parseGroupMentions("@Ada!", members).memberIds, ["a1"]);
    assert.deepEqual(parseGroupMentions("x@Ada", members).memberIds, [], "a mention inside a word is not one");
    assert.deepEqual(parseGroupMentions("@Ada1", members).memberIds, [], "a longer word is a different word");
    assert.deepEqual(parseGroupMentions("@Grace Hopper @Ada again", members).memberIds, ["a1", "a2"], "the members' order decides, not the text's");
    assert.deepEqual(parseGroupMentions("@Ada @Ada @Ada", members).memberIds, ["a1"], "a member is mentioned once");
    assert.equal(parseGroupMentions("@All please", members).isEveryone, true, "everyone is matched without case");
    assert.equal(parseGroupMentions("@everyonex please", members).isEveryone, false, "everyone has to be the whole word");
    assert.equal(parseGroupMentions("email @everyone@example.com", members).isEveryone, true, "the word stands alone even when an address follows it");
  });

  it("answers everyone until the last thing the user said names someone, and ignores older rounds", () => {
    const history: GroupMessage[] = [
      { speaker: { kind: "user" }, content: "@Grace Hopper" },
      { speaker: { kind: "user" }, content: "hello room" },
    ];
    assert.deepEqual(resolveResponders(members, history).map((member) => member.id), ["a1", "a2", "a3"], "a mention before the last user message is an older round");
    assert.deepEqual(resolveResponders(members, []).map((member) => member.id), ["a1", "a2", "a3"]);
    assert.deepEqual(resolveResponders(members, [{ speaker: { kind: "user" }, content: "@Grace Hopper" }]).map((member) => member.id), ["a2"]);
    assert.deepEqual(resolveResponders(members, [{ speaker: { kind: "user" }, content: "@everyone" }]).map((member) => member.id), ["a1", "a2", "a3"]);
    const noUserYet: GroupMessage[] = [
      { speaker: { kind: "member", id: "a2", name: "Grace Hopper" }, content: "@Ada look" },
      { speaker: { kind: "member", id: "a1", name: "Ada Lovelace" }, content: "hello" },
    ];
    assert.deepEqual(resolveResponders(members, noUserYet).map((member) => member.id), ["a1"], "with no user message the whole transcript is the round");
    assert.deepEqual(
      resolveResponders(members, [{ speaker: { kind: "user" }, content: "@everyone" }, { speaker: { kind: "user" }, content: "@Grace Hopper" }]).map((member) => member.id),
      ["a2"],
      "the round starts at the last user message, so an earlier call to everyone is an older round",
    );
    assert.deepEqual(
      resolveResponders(members, [
        { speaker: { kind: "user" }, content: "@everyone" },
        { speaker: { kind: "member", id: "a2", name: "Grace Hopper" }, content: "@Ada you first" },
      ]).map((member) => member.id),
      ["a1", "a2", "a3"],
      "one call to everyone in the round answers for everyone, whatever is said after it",
    );
    assert.deepEqual(
      resolveResponders(members, [{ speaker: { kind: "user" }, content: "@everyone @Grace Hopper" }]).map((member) => member.id),
      ["a1", "a2", "a3"],
      "everyone wins over a name mentioned beside it",
    );
  });

  it("bounds the transcript from the end, and a limit of zero is no bound at all", () => {
    const history: GroupMessage[] = [
      { speaker: { kind: "user" }, content: "one" },
      { speaker: { kind: "member", id: "a2", name: "Grace" }, content: "two" },
      { speaker: { kind: "user" }, content: "three" },
    ];
    assert.deepEqual(formatGroupHistory(history, "a1", 1).split("\n"), ["User: three"]);
    assert.deepEqual(formatGroupHistory(history, "a1", 2).split("\n"), ["Grace: two", "User: three"]);
    assert.equal(formatGroupHistory(history, "a1", 0).split("\n").length, 3, "the bound is a negative slice, so zero keeps everything");
  });

  it("says where a group's name comes from, and describes it with or without its own description", () => {
    assert.equal(groupDisplayName({ name: "  Room  ", description: "" }), "Room");
    assert.equal(groupDisplayName({ name: "", description: "x" }), "the group");
    assert.equal(describeGroup({ name: "Room", description: "" }), '"Room"');
    assert.equal(describeGroup({ name: "  ", description: "  " }), '"the group"');
    assert.equal(describeGroup({ name: "Room", description: "  a shared room  " }), '"Room" — a shared room');
    assert.equal(formatGroupChatTag({ name: "", description: "" }, []), '[Group chat: "the group"]');
  });

  it("counts the nesting refusal in the plural, and keeps its own copy of the ids", () => {
    const ids = ["g1"];
    const one = new SlateGroupNestingError(ids);
    ids.push("g2");
    assert.equal(one.message, "A group chat can only contain individual agents, not other group chats. Remove the group chat from the member list.");
    assert.deepEqual(one.nestedGroupIds, ["g1"], "the ids are copied out of the caller's list");
    assert.equal(one.name, "SlateGroupNestingError");
    assert.match(new SlateGroupNestingError(["g1", "g2"]).message, /Remove the group chats from the member list\.$/);
  });

  it("tells a message that is passing from one that could still become a pass", () => {
    assert.equal(isPassContent("( pass )."), true);
    assert.equal(isPassContent("passed"), false);
    assert.equal(isPotentialPassPrefix(""), true);
    assert.equal(isPotentialPassPrefix("  (pas"), true, "a reply still being typed may become a pass");
    assert.equal(isPotentialPassPrefix("pass"), true);
    assert.equal(isPotentialPassPrefix("passes"), false);
    assert.equal(isPotentialPassPrefix("here"), false);
  });

  it("tags a turn only when the text, hidden marker or not, starts with the group tag", () => {
    assert.equal(isGroupTurnPromptText("[SLATE_HIDDEN_PROMPT]hello"), false, "the marker alone is not a tag");
    assert.equal(isGroupTurnPromptText('[SLATE_HIDDEN_PROMPT][Group chat: "Room"] hi'), true);
    assert.equal(isGroupTurnPromptText(""), false);
    assert.equal(buildGroupRedriveNote().startsWith("\n(Redelivery: your previous attempt"), true);
    assert.equal(buildGroupRedriveNote().includes("SendMessage"), true);
  });

  it("tells a member who it is, who is in the room, and how to speak, in a shared room or a private one", () => {
    const alone = buildGroupMemberSystemPrompt({ id: "a1", name: "Ada", description: "  a mathematician  " }, { name: "Room", description: "" }, []);
    assert.equal(alone.includes('You are Ada, one participant in a group chat ("Room").'), true);
    assert.equal(alone.includes("Your persona: a mathematician"), true);
    assert.equal(alone.includes("Other participants in the room:"), false);
    assert.equal(alone.includes("Right now you are speaking in this group chat."), true, "no peers means no list after the comma");
    assert.equal(alone.includes("You have your full toolkit in this room."), true);
    assert.equal(alone.includes('send exactly "(pass)"'), true);

    const together = buildGroupMemberSystemPrompt(
      { id: "a1", name: "Ada", description: "" },
      { name: "Room", description: "a shared room" },
      [{ id: "a2", name: "Grace", description: "  a rear admiral  " }, { id: "a3", name: "Alan", description: "" }],
      { isSharedRoom: true },
    );
    assert.equal(together.includes("Other participants in the room:\n- Grace (a rear admiral)\n- Alan"), true);
    assert.equal(together.includes("Right now you are speaking in this group chat, with Grace, Alan."), true);
    assert.equal(together.includes("This is a cross-user room turn."), true);
    assert.equal(together.includes("You have your full toolkit in this room."), false, "a cross-user room turn has the narrower rule");
  });

  it("prompts a turn with the room since the member last spoke, or says there was nothing new", () => {
    const quiet = buildGroupTurnPrompt({ member: members[0]!, group: { name: "Room", description: "" }, peers: [], newMessages: [] });
    assert.equal(quiet.startsWith('[Group chat: "Room"]'), true);
    assert.equal(quiet.includes("No new messages in the room since your last turn."), true);
    assert.equal(quiet.endsWith("It's your turn, Ada Lovelace. Reply in character with a single SendMessage if you have something worth adding, or send \"(pass)\" if you don't."), true);

    const busy = buildGroupTurnPrompt({
      member: members[0]!,
      group: { name: "Room", description: "" },
      peers: [members[1]!],
      newMessages: [
        { speaker: { kind: "member", id: "a2", name: "Grace Hopper" }, content: "on it" },
        { speaker: { kind: "user" }, content: "thanks" },
      ],
    });
    assert.equal(busy.includes("New messages in the room (oldest first):\nGrace Hopper: on it\nUser: thanks"), true);
  });
});

describe("the context the host's runner runs in", () => {
  it("carries a logger that keeps quiet", () => {
    const created = createProductionRunnerContext();
    assert.equal(typeof created, "object");
    const backend = getLoggerBackend(created);
    assert.equal(typeof backend?.log, "function");
    assert.equal(backend.log(context, { level: "info", message: "nothing to see" } as never), undefined);
  });
});

describe("the subagent that drives the box's browser", () => {
  it("matches its type however a caller spells it", () => {
    assert.equal(BROWSER_USE_SUBAGENT_TYPE, "browserUse");
    assert.equal(isBrowserUseSubagentType("browserUse"), true);
    assert.equal(isBrowserUseSubagentType("browser_use"), true);
    assert.equal(isBrowserUseSubagentType("Browser-Use"), true);
    assert.equal(isBrowserUseSubagentType("browseruse"), true);
    assert.equal(isBrowserUseSubagentType("computerUse"), false);
    assert.equal(isBrowserUseSubagentType(null), false);
  });

  it("folds separators and case away, and nothing else", () => {
    assert.equal(isBrowserUseSubagentType(" Browser Use "), true, "a space is a separator wherever it sits");
    assert.equal(isBrowserUseSubagentType("b r o w s e r u s e"), true, "every separator is dropped, not just the word breaks");
    assert.equal(isBrowserUseSubagentType("browser_-_use"), true);
    assert.equal(isBrowserUseSubagentType("browser\tuse"), false, "a tab is not one of the separators");
    assert.equal(isBrowserUseSubagentType("browser usage"), false);
    assert.equal(isBrowserUseSubagentType(""), false);
    assert.equal(isBrowserUseSubagentType(undefined), false);
  });

  it("carries the words the model is given, joined into one description", () => {
    assert.equal(BROWSER_USE_SUBAGENT_DESCRIPTION.includes("page level"), true);
    assert.equal(BROWSER_USE_SUBAGENT_DESCRIPTION.includes("Prefer it over computerUse for browser-only work"), true);
    assert.equal(BROWSER_USE_SUBAGENT_DESCRIPTION.includes("cannot act as the user"), true);
    assert.equal(BROWSER_USE_SUBAGENT_DESCRIPTION.includes("request_box_help"), true);
    assert.equal(BROWSER_USE_SUBAGENT_DESCRIPTION.includes("  "), false, "the lines are joined with single spaces");
    assert.equal(BROWSER_USE_SUBAGENT_DESCRIPTION.includes("\n"), false);
    assert.equal(BROWSER_USE_SUBAGENT_DESCRIPTION.length, 1134);
    assert.equal(BROWSER_USE_SUBAGENT_DESCRIPTION.endsWith("continue."), true);
  });

  it("registers itself as a custom built-in subagent, with its own type and description each time", () => {
    const config = createSlateBrowserUseSubagentConfig();
    assert.deepEqual(config, {
      subagent_type: { type: { case: "custom", value: { name: "browserUse" } } },
      description: BROWSER_USE_SUBAGENT_DESCRIPTION,
      preserveTaskTool: false,
      subagentSource: "builtin",
    });
    assert.deepEqual(Object.keys(config), ["subagent_type", "description", "preserveTaskTool", "subagentSource"]);
    const second = createSlateBrowserUseSubagentConfig();
    assert.equal(config !== second, true, "every registration is its own object");
    assert.equal(config.subagent_type !== second.subagent_type, true);
    config.subagent_type.type.value.name = "changed";
    assert.equal(second.subagent_type.type.value.name, "browserUse", "one registration cannot change the next");
  });
});

describe("an event-bus failure", () => {
  it("is reported with the fields the backend takes", () => {
    assert.equal(HOST_EVENT_BUS_EVENT, "slate.host.event_bus");
    assert.deepEqual(hostEventBusTelemetry({ kind: "publish", topic: "room", errorClass: "EPIPE" }), {
      level: "error",
      event: "slate.host.event_bus",
      metadata: { kind: "publish", topic: "room", error_class: "EPIPE" },
    });
  });
});

describe("a departure that could not be delivered yet", () => {
  it("records each departure once and clears it by what identifies it", () => {
    const store = createInMemoryXuserPendingDepartures();
    const leave = { kind: "leave-room", roomId: "r1", agentId: "a1" } as const;
    store.record(leave);
    store.record(leave);
    store.record({ kind: "remove-agent", agentId: "a2" } as const);
    assert.equal(store.list().length, 2);
    assert.equal(departureKey(leave), "leave-room\0\0r1");
    assert.equal(departureKey({ kind: "remove-agent", ownerAuthId: "o", agentId: "a2" }), "remove-agent\0o\0a2");
    store.clear(leave);
    assert.deepEqual(store.list().map((value) => value.kind), ["remove-agent"]);
  });

  it("keeps what it recorded across instances", () => {
    const root = join(scratch, "departures");
    const store = new SlateXuserPendingDepartureStore(root);
    store.record({ kind: "remove-agent", agentId: "a3" });
    assert.deepEqual(store.list().map((value) => value.agentId), ["a3"]);
    assert.deepEqual(new SlateXuserPendingDepartureStore(root).list().map((value) => value.agentId), ["a3"]);
    store.clear({ kind: "remove-agent", agentId: "a3" });
    assert.deepEqual(store.list(), []);
    assert.deepEqual(new SlateXuserPendingDepartureStore(root).list(), []);
  });

  it("reads the file's shape defensively, keeping only the entries that name a departure", () => {
    assert.equal(SLATE_XUSER_PENDING_DEPARTURE_FILE_NAME, "host-xuser-pending-departures.json");
    assert.deepEqual([...parseDepartureFile(null).keys()], []);
    assert.deepEqual([...parseDepartureFile(undefined as unknown as string | null).keys()], []);
    assert.deepEqual([...parseDepartureFile("{ half a file").keys()], []);
    assert.deepEqual([...parseDepartureFile("null").keys()], []);
    assert.deepEqual([...parseDepartureFile('{"pending":"x"}').keys()], []);
    assert.deepEqual([...parseDepartureFile('{"pending":[null,3,"x",[]]}').keys()], []);
    assert.deepEqual([...parseDepartureFile('{"pending":{"kind":"remove-agent","agentId":"a9"}}').keys()], []);
    const parsed = parseDepartureFile(JSON.stringify({
      version: 2,
      pending: [
        { kind: "remove-agent", agentId: "a1" },
        { kind: "leave-room", roomId: "r1", agentId: "a2", ownerAuthId: "o" },
        { kind: "remove-agent" },
        { kind: "remove-agent", agentId: "" },
        { kind: "remove-agent", agentId: 7 },
        { kind: "remove-agent", agentId: "a3", ownerAuthId: "" },
        { kind: "leave-room", agentId: "a4" },
        { kind: "leave-room", roomId: "", agentId: "a5" },
        { kind: "remove-agent", agentId: "a6", ownerAuthId: 5 },
        { kind: "not-a-departure", agentId: "a7" },
      ],
    }));
    assert.deepEqual([...parsed.values()], [
      { kind: "remove-agent", agentId: "a1" },
      { kind: "leave-room", ownerAuthId: "o", roomId: "r1", agentId: "a2" },
      { kind: "remove-agent", agentId: "a3" },
      { kind: "remove-agent", agentId: "a6" },
    ]);
    assert.deepEqual([...parsed.keys()], ["remove-agent\0\0a1", "leave-room\0o\0r1", "remove-agent\0\0a3", "remove-agent\0\0a6"]);
  });

  it("keeps the last of two entries that identify the same departure, where the first one sat", () => {
    const parsed = parseDepartureFile(JSON.stringify({ pending: [
      { kind: "remove-agent", agentId: "a1" },
      { kind: "remove-agent", agentId: "a2" },
      { kind: "remove-agent", agentId: "a1" },
    ] }));
    assert.deepEqual([...parsed.keys()], ["remove-agent\0\0a1", "remove-agent\0\0a2"]);
    assert.equal(parsed.size, 2);
  });

  it("writes the file's version and its list in one rename, and reads the text back whole", () => {
    const root = join(scratch, "departures-format");
    const store = new SlateXuserPendingDepartureStore(root);
    store.record({ kind: "leave-room", ownerAuthId: "o", roomId: "r1", agentId: "a1" });
    store.record({ kind: "remove-agent", agentId: "ü" });
    const path = join(root, SLATE_XUSER_PENDING_DEPARTURE_FILE_NAME);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify({ version: 2, pending: [
      { kind: "leave-room", ownerAuthId: "o", roomId: "r1", agentId: "a1" },
      { kind: "remove-agent", agentId: "ü" },
    ] }));
    assert.deepEqual(readdirSync(root), [SLATE_XUSER_PENDING_DEPARTURE_FILE_NAME], "the temporary file is renamed away");
    assert.deepEqual(new SlateXuserPendingDepartureStore(root).list().map((value) => value.agentId), ["a1", "ü"]);
  });

  it("does not write the file again for a departure it already has or one it never had", () => {
    const root = join(scratch, "departures-nowrite");
    const store = new SlateXuserPendingDepartureStore(root);
    store.record({ kind: "remove-agent", agentId: "a1" });
    const path = join(root, SLATE_XUSER_PENDING_DEPARTURE_FILE_NAME);
    rmSync(path);
    store.record({ kind: "remove-agent", agentId: "a1" });
    assert.equal(existsSync(path), false, "a departure already recorded is not written again");
    store.clear({ kind: "remove-agent", agentId: "nobody" });
    assert.equal(existsSync(path), false, "a departure that was never recorded is not written again");
    store.clear({ kind: "remove-agent", agentId: "a1" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 2, pending: [] });
  });

  it("reads the file once per store, and a file that is not the shape reads as no departures", () => {
    const root = join(scratch, "departures-cache");
    const writer = new SlateXuserPendingDepartureStore(root);
    writer.record({ kind: "remove-agent", agentId: "a1" });
    const reader = new SlateXuserPendingDepartureStore(root);
    assert.deepEqual(reader.list().map((value) => value.agentId), ["a1"]);
    new SlateXuserPendingDepartureStore(root).record({ kind: "remove-agent", agentId: "a2" });
    assert.deepEqual(reader.list().map((value) => value.agentId), ["a1"], "the file is read once per store");
    assert.deepEqual(new SlateXuserPendingDepartureStore(root).list().map((value) => value.agentId), ["a1", "a2"]);
    writeFileSync(join(root, SLATE_XUSER_PENDING_DEPARTURE_FILE_NAME), "half a file");
    const corrupt = new SlateXuserPendingDepartureStore(root);
    assert.deepEqual(corrupt.list(), []);
    corrupt.record({ kind: "remove-agent", agentId: "a3" });
    assert.deepEqual(parseDepartureFile(readFileSync(join(root, SLATE_XUSER_PENDING_DEPARTURE_FILE_NAME), "utf8")).size, 1);
  });

  it("overwrites the departure the in-memory store already holds, and hands out a copy of its list", () => {
    const store = createInMemoryXuserPendingDepartures();
    store.record({ kind: "remove-agent", agentId: "a1" });
    store.record({ kind: "remove-agent", agentId: "a2" } as never);
    store.record({ kind: "remove-agent", agentId: "a1", mark: "second" } as never);
    assert.deepEqual(store.list().map((value) => value.agentId), ["a1", "a2"], "the position the first entry took is kept");
    assert.equal((store.list()[0] as unknown as Record<string, unknown>).mark, "second", "the value is replaced");
    const copy = store.list();
    copy.length = 0;
    assert.deepEqual(store.list().map((value) => value.agentId), ["a1", "a2"], "the list is a copy");
  });

  it("reads no departures from a path that is not a file, and still answers what it was given", () => {
    const root = join(scratch, "departures-dir");
    const store = new SlateXuserPendingDepartureStore(root);
    mkdirSync(store.filePath, { recursive: true });
    assert.deepEqual(new SlateXuserPendingDepartureStore(root).list(), []);
    store.record({ kind: "remove-agent", agentId: "a1" });
    assert.deepEqual(store.list().map((value) => value.agentId), ["a1"], "a store that cannot write still answers what it recorded");
  });

  it("keeps a departure in memory when the file cannot be written", () => {
    const root = join(scratch, "departures-unwritable");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "blocked"), "x");
    const store = new SlateXuserPendingDepartureStore(join(root, "blocked", "nested"));
    store.record({ kind: "remove-agent", agentId: "a1" });
    assert.deepEqual(store.list().map((value) => value.agentId), ["a1"]);
  });
});

describe("catching the host up with the shared state", () => {
  function harness(options: { enabled?: boolean; rooms?: XuserRoom[]; failFetch?: boolean } = {}) {
    const rooms: XuserRoom[] = options.rooms ?? [];
    const calls: string[] = [];
    const typingUsers = new Map<string, { roomId: string; authId: string }>([["t1", { roomId: "r1", authId: "human-1" }]]);
    const host: XuserStateReconcileHost = {
      relay: {
        fetchShareState: async () => {
          calls.push("fetchShareState");
          if (options.failFetch === true) throw new Error("relay is away");
          return { pendingJoinRequests: [{ id: "j1" }], rooms };
        },
        addOwnAgent: async () => ({}),
        setRoomPicture: async () => ({}),
      },
      manager: {
        getAgentDisplayProfile: async () => null,
        findRoomAgentId: async () => null,
        ensureMirrorRoom: async () => { calls.push("ensureMirrorRoom"); },
        ensureHostedSharedRoom: async (args) => { calls.push(`ensureHostedSharedRoom:${JSON.stringify(args)}`); return "room-agent-1"; },
      },
      isEnabled: () => options.enabled ?? true,
      getSelfAuthId: () => "self",
      setSelfAuthId: () => {},
      readSelfAuthId: async () => "self",
      getRooms: () => rooms,
      setRooms: (next) => { rooms.length = 0; rooms.push(...next); },
      setPendingJoinRequests: (requests) => { calls.push(`pending:${requests.length}`); },
      typingUsers,
      typingExpiryHandles: new Map(),
      emit: () => { calls.push("emit"); },
      departures: () => ({ isRoomAbandoned: () => false, flushPendingDepartures: async () => { calls.push("flush"); }, pruneRoomTombstones: () => { calls.push("prune"); } }),
      agentAvatarPayload: async () => undefined,
    };
    return { reconcile: new SlateXuserStateReconcile(host), rooms, calls, typingUsers };
  }

  it("does nothing at all while it is off, and stays quiet when the relay is away", async () => {
    const off = harness({ enabled: false });
    await off.reconcile.runReconcilePass();
    assert.deepEqual(off.calls, []);
    const broken = harness({ failFetch: true });
    await broken.reconcile.runReconcilePass();
    assert.deepEqual(broken.calls, ["flush", "fetchShareState"]);
  });

  it("takes what the relay reports, prunes what is gone, and drops typing for people who left", async () => {
    const room: XuserRoom = { roomId: "r1", name: "Room", hostAuthId: "self", members: [{ kind: "agent", authId: "self", agentId: "a1" }, { kind: "agent", authId: "other", agentId: "a2", displayName: "Remote" }] };
    const { reconcile, rooms, calls, typingUsers } = harness({ rooms: [room] });
    await reconcile.runReconcilePass();
    assert.deepEqual(calls.slice(0, 4), ["flush", "fetchShareState", "pending:1", "prune"]);
    assert.equal(rooms.length, 1);
    assert.equal(typingUsers.size, 0);
    assert.equal(calls.includes("emit"), true);
    assert.match(calls.find((call) => call.startsWith("ensureHostedSharedRoom")) ?? "", /"localMemberIds":\["a1"\]/);
    assert.match(calls.find((call) => call.startsWith("ensureHostedSharedRoom")) ?? "", /"roomId":"r1"/);
  });
});

describe("tracing a send", () => {
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("traces nothing when no factory was installed, and refuses a traceparent that is not one", () => {
    setHostTraceFactory(undefined as never);
    assert.equal(beginSendTrace(traceparent), undefined);
    const asked: string[] = [];
    setHostTraceFactory((options) => { asked.push(options.name); return { span: { setAttribute: () => {}, recordException: () => {}, setStatus: () => {}, end: () => {} } }; });
    assert.equal(beginSendTrace("not-a-traceparent"), undefined);
    assert.equal(adoptRemoteParent(undefined, "slate.send"), undefined);
    assert.deepEqual(asked, []);
  });

  it("adopts the trace a send arrived under, and names gateway commands after their method", () => {
    const names: string[] = [];
    setHostTraceFactory((options) => { names.push(options.name); return { span: { setAttribute: () => {}, recordException: () => {}, setStatus: () => {}, end: () => {} } }; });
    assert.equal(beginSendTrace(traceparent) !== undefined, true);
    assert.equal(beginGatewayCommandTrace({ traceparent, method: "sendMessage" }) !== undefined, true);
    assert.deepEqual(names, ["slate.send", "slate.gateway.sendMessage"]);
    assert.equal(SLATE_TURN_ROOT_SPAN_NAME, "slate.turn.run");
    setHostTraceFactory(() => { throw new Error("tracing is broken"); });
    assert.equal(beginSendTrace(traceparent), undefined);
    setHostTraceFactory(undefined as never);
  });
});

describe("what a trigger may say", () => {
  it("parses and serializes the listeners a stored trigger holds", () => {
    const slack = parseStoredTrigger({ type: "slack", channel: "#ops  ", match: { kind: "keyword", keyword: " deploy " } });
    assert.deepEqual(slack, { type: "slack", channel: "#ops", match: { kind: "keyword", keyword: "deploy" } });
    assert.equal(parseStoredTrigger({ type: "slack", channel: "", match: { kind: "mention" } }), null);
    assert.equal(parseStoredTrigger({ type: "slack", channel: "#ops" }), null);
    const group = parseStoredTrigger({ type: "group", listeners: [{ type: "slack", channel: "#ops", match: { kind: "mention" } }, { type: "cron", schedule: "0 9 * * *" }] });
    assert.equal(group?.type, "group");
    assert.deepEqual(serializeStoredTrigger(group!), { type: "group", listeners: [{ type: "slack", channel: "#ops", match: { kind: "mention" } }, { type: "cron", schedule: "0 9 * * *" }] });
    assert.equal(triggerIdentity({ type: "cron", schedule: "0 9 * * *" }), "cron:0 9 * * *");
    assert.equal(parseStoredTrigger("nonsense"), null);
  });

  it("keeps a github listener only when it names a repo and an event it knows", () => {
    const listener = parseStoredTrigger({ type: "github", repo: "org/repo", events: ["pr-opened", "made-up", "ci-passed"], ciBranch: "main" });
    assert.deepEqual(listener, { type: "github", repo: "org/repo", events: ["pr-opened", "ci-passed"], ciBranch: "main" });
    assert.equal(parseStoredTrigger({ type: "github", repo: "not a repo", events: ["pr-opened"] }), null);
    assert.equal(parseStoredTrigger({ type: "github", repo: "org/repo", events: ["made-up"] }), null);
    // A listener that watches only CI has nothing to match on without a branch, so it is dropped.
    assert.equal(parseStoredTrigger({ type: "github", repo: "org/repo", events: ["ci-passed"] }), null);
  });

  it("matches a Slack event by scope, mention, keyword or reaction", () => {
    assert.equal(slackScopeMatches("*", "#anything"), true);
    assert.equal(slackScopeMatches("#ops", "ops"), true);
    assert.equal(slackScopeMatches("#ops", "@ops"), false);
    assert.equal(slackScopeMatches("ops", "#OPS"), true);
    const mention = parseStoredTrigger({ type: "slack", channel: "#ops", match: { kind: "mention" } })!;
    assert.equal(slackListenerMatches(mention as never, { channel: "#ops", isMention: true, text: "hi" }), true);
    assert.equal(slackListenerMatches(mention as never, { channel: "#ops", isMention: false, text: "hi" }), false);
    assert.equal(slackListenerMatches(mention as never, { channel: "#other", isMention: true }), false);
    const keyword = parseStoredTrigger({ type: "slack", channel: "#ops", match: { kind: "keyword", keyword: "Deploy" } })!;
    assert.equal(slackListenerMatches(keyword as never, { channel: "#ops", text: "please deploy now" }), true);
    assert.equal(slackListenerMatches(keyword as never, { channel: "#ops", text: "nothing" }), false);
    const reaction = parseStoredTrigger({ type: "slack", channel: "#ops", match: { kind: "reaction", emoji: ["eyes"], bySelf: true } })!;
    assert.equal(slackListenerMatches(reaction as never, { channel: "#ops", reactionEmoji: ":eyes:", isSelf: true }), true);
    assert.equal(slackListenerMatches(reaction as never, { channel: "#ops", reactionEmoji: ":eyes:", isSelf: false }), false);
  });

  it("matches a GitHub event by kind, branch and who did it", () => {
    const listener = parseStoredTrigger({ type: "github", repo: "org/repo", events: ["pr-opened", "ci-passed"], ciBranch: "main", userAllowlist: ["Ada"] })!;
    assert.equal(githubListenerMatches(listener as never, { repo: "Org/Repo", kind: "pr-opened", prOwner: "ada" }), true);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "pr-opened", prOwner: "grace" }), false);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "pr-opened", prOwner: undefined }), false);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "pr-opened", prOwner: undefined }, { admitMissingSubject: true }), true);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "ci-passed", branch: "main" }), true);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "ci-passed", branch: "other" }), false);
    assert.equal(githubListenerMatches(listener as never, { repo: "org/repo", kind: "pr-merged" }), false);
  });

  it("matches the platform listeners by their own fields", () => {
    const cron = parseStoredTrigger({ type: "cron", schedule: "0 9 * * *" })!;
    assert.equal(triggerMatchesEvent(cron, { source: "cron" }), false);
    const linear = parseStoredTrigger({ type: "linear", event: { case: "statusChanged", statusIds: ["s1"] }, projectIds: ["p1"], teamIds: [] })!;
    assert.equal(listenerMatchesEvent(linear as never, { source: "linear", event: "statusChanged", projectId: "p1", statusId: "s1" }), true);
    assert.equal(listenerMatchesEvent(linear as never, { source: "linear", event: "statusChanged", projectId: "p1", statusId: "s2" }), false);
    assert.equal(listenerMatchesEvent(linear as never, { source: "linear", event: "statusChanged", projectId: "p2", statusId: "s1" }), false);
    assert.equal(listenerMatchesEvent(linear as never, { source: "sentry", event: "statusChanged" }), false);
    const sentry = parseStoredTrigger({ type: "sentry", event: { case: "issueAny" }, projectIds: [] })!;
    assert.equal(listenerMatchesEvent(sentry as never, { source: "sentry", event: "issueResolved" }), true);
    const pagerduty = parseStoredTrigger({ type: "pagerduty", event: { case: "incidentTriggered" }, serviceIds: ["svc"] })!;
    assert.equal(listenerMatchesEvent(pagerduty as never, { source: "pagerduty", event: "incidentTriggered", serviceId: "svc" }), true);
    assert.equal(listenerMatchesEvent(pagerduty as never, { source: "pagerduty", event: "incidentTriggered", serviceId: "other" }), false);
  });

  it("describes an event, and hands it to the model as a block", () => {
    assert.equal(describeTriggerEvent({ source: "slack", sender: "Kee", channel: "#ops", text: "deploy" }), 'Kee in #ops: "deploy"');
    assert.equal(describeTriggerEvent({ source: "slack", sender: "Kee", channel: "#ops", reactionEmoji: ":eyes:" }), "Kee reacted :eyes: in #ops");
    assert.equal(describeTriggerEvent({ source: "github", kind: "pr-opened", repo: "org/repo", title: "Fix", actor: "ada" }), 'PR opened in org/repo: "Fix" by ada');
    assert.equal(describeTriggerEvent({ source: "linear", event: "issueCreated", issueIdentifier: "ENG-1" }), 'Issue created: "ENG-1"');
    const block = buildTriggerEventContextBlock({ source: "slack", text: "<b>hi</b>", channel: "#ops" });
    assert.match(block, /^<slack_message>\n/);
    assert.match(block, /\n<\/slack_message>$/);
    assert.equal(block.includes("<b>"), false);
    assert.match(buildTriggerEventContextBlock({ source: "unknown" }), /^<trigger_event>/);
  });
});

describe("moving files into and out of a box", () => {
  it("accepts the roots a box has and resolves paths inside its workspace", () => {
    assert.deepEqual([...BOX_PATH_ROOTS], ["/workspace", "/home", "/root"]);
    assert.equal(isBoxRootPath("/workspace"), true);
    assert.equal(isBoxRootPath("/workspace/file"), true);
    assert.equal(isBoxRootPath("/etc/passwd"), false);
    assert.equal(isBoxRootPath("/workspaces"), false);
    assert.equal(SLATE_BOX_UPLOADS_DIR, "/workspace/uploads");
    assert.equal(resolveBoxWorkspacePath("a/b"), "/workspace/a/b");
    assert.equal(resolveBoxWorkspacePath("/workspace/a/../b"), "/workspace/b");
    assert.equal(SLATE_BOX_WORKSPACE_ROOT, "/workspace");
    assert.equal(DEFAULT_BOX_TRANSFER_MAX_BYTES, 256 * 1024 * 1024);
    assert.equal(new BoxFileUnreadableError().name, "BoxFileUnreadableError");
  });
});

describe("the shape of a box store's manifest", () => {
  it("reads both manifest versions and turns away an entry it cannot trust", () => {
    const legacy = manifestSchema.safeParse({ version: 1, updatedAtMs: 5, entries: { "a.txt": { sha: "aa", size: 1 } } });
    assert.equal(legacy.success, true);
    const current = manifestSchema.safeParse({ version: 2, updatedAtMs: 5, entries: { "a.txt": { kind: "file", sha: "aa", size: 1, mode: 420 }, "link": { kind: "symlink", target: "/workspace/a.txt" } } });
    assert.equal(current.success, true);
    assert.equal(manifestSchema.safeParse({ version: 2, updatedAtMs: 5, entries: { "a.txt": { kind: "file", sha: "aa", size: 1, mode: 9999 } } }).success, false);
    assert.equal(manifestSchema.safeParse({ version: 3, updatedAtMs: 5, entries: {} }).success, false);
    assert.equal(BOX_STORE_MANIFEST_VERSION, 2);
  });

  it("tells a file from a symlink, and compares two entries by what they mean", () => {
    const file = { kind: "file", sha: "aa", size: 1, mode: 420 } as const;
    const link = { kind: "symlink", target: "/workspace/a" } as const;
    assert.equal(isBoxStoreManifestFileEntry(file), true);
    assert.equal(isBoxStoreManifestFileEntry(link), false);
    assert.equal(isBoxStoreManifestSymlinkEntry(link), true);
    assert.equal(isSymlinkManifestValue(link), true);
    assert.equal(isSymlinkManifestValue(file), false);
    assert.equal(boxStoreManifestEntriesEqual(file, { ...file }), true);
    assert.equal(boxStoreManifestEntriesEqual(file, { ...file, sha: "bb" }), false);
    assert.equal(boxStoreManifestEntriesEqual(link, { kind: "symlink", target: "/workspace/a" }), true);
    assert.equal(boxStoreManifestEntriesEqual(link, file), false);
    assert.equal(boxStoreManifestEntriesEqual(null, null), true);
    assert.equal(boxStoreManifestEntriesEqual(null, file), false);
  });
});

describe("composing the request that launches a cloud agent", () => {
  it("needs a model when parameters were given, and takes one otherwise", () => {
    assert.equal(buildCloudAgentRequestedModel(undefined, undefined), null);
    assert.equal(buildCloudAgentRequestedModel("  ", {}), null);
    assert.throws(() => buildCloudAgentRequestedModel(undefined, { effort: "high" }), Error);
    assert.deepEqual(buildCloudAgentRequestedModel(" gpt ", { effort: "high" }), { modelId: "gpt", maxMode: true, parameters: [{ id: "effort", value: "high" }] });
  });

  it("reads a repository reference however it was written", () => {
    assert.equal(normalizeRepoReference("org/repo"), "https://github.com/org/repo");
    assert.equal(normalizeRepoReference("https://github.com/org/repo"), "https://github.com/org/repo");
    assert.equal(sanitizeRemoteUrl("github.com/Org/Repo.git"), "github.com/org/repo");
    assert.equal(sanitizeRemoteUrl("git@github.com:org/repo.git"), "github.com/org/repo");
    assert.equal(sanitizeRemoteUrl(""), "");
    assert.equal(sanitizeRemoteUrlForHttpUrl("github.com/org/repo"), "https://github.com/org/repo");
    assert.deepEqual(buildRepoFromRemote("org/repo"), { sanitizedRepoUrl: "github.com/org/repo", httpRepoUrl: "https://github.com/org/repo" });
    assert.deepEqual(buildRepoFromRemote("org/repo", "main"), { sanitizedRepoUrl: "github.com/org/repo", httpRepoUrl: "https://github.com/org/repo", baseBranch: "main" });
  });

  it("insists on a repository the saved environment actually has", () => {
    assert.equal(resolveLaunchRepoReference("org/repo", undefined), "org/repo");
    assert.throws(() => resolveLaunchRepoReference(undefined, undefined), Error);
    const environment = { publicId: "env-1", name: "Team", repoConfig: { repos: [{ repoUrl: "https://github.com/org/primary" }, { repoUrl: "https://github.com/org/secondary" }] } };
    assert.equal(resolveLaunchRepoReference(undefined, environment), "https://github.com/org/primary");
    assert.equal(resolveLaunchRepoReference("org/primary", environment), "https://github.com/org/primary");
    assert.throws(() => resolveLaunchRepoReference("org/secondary", environment), /secondary repo/);
    assert.throws(() => resolveLaunchRepoReference("org/other", environment), /is not part of/);
    const empty = { publicId: "env-2", name: "" };
    assert.throws(() => resolveLaunchRepoReference(undefined, empty), /has no repositories configured/);
  });

  it("routes a launch through a private worker only when the environment asks for it", () => {
    assert.deepEqual(resolveCloudAgentEnvironmentFields("org/repo", { type: "cloud" }), {});
    assert.deepEqual(resolveCloudAgentEnvironmentFields("org/repo", undefined), {});
    assert.deepEqual(resolveCloudAgentEnvironmentFields("org/repo", { type: "pool", name: " pool " }), {
      usePrivateWorker: true,
      labels: [{ key: "repo", value: "org/repo" }, { key: "pool", value: "pool" }],
    });
    assert.deepEqual(resolveCloudAgentEnvironmentFields("org/repo", { type: "machine", name: " box " }), {
      usePrivateWorker: true,
      labels: [{ key: "name", value: "box" }, { key: "slate.private_worker.shared_assignment_allowed", value: "true" }],
    });
    assert.throws(() => resolveCloudAgentEnvironmentFields("org/repo", { type: "machine", name: "  " }), /registered name/);
  });
});

describe("the marker that says the browser's user-agent token is off", () => {
  it("writes it while the switch is on, removes it when it is off, and leaves it alone otherwise", async () => {
    const path = join(scratch, "ua-token-disabled");
    let enabled = true;
    const logged: string[] = [];
    const reconcile = createUaTokenKillSwitchReconciler({ path, isKillSwitchEnabled: () => enabled, log: (message) => { logged.push(message); } });
    await reconcile();
    assert.equal(readFileSync(path, "utf8"), "1\n");
    await reconcile();
    enabled = false;
    await reconcile();
    assert.equal(existsSync(path), false);
    // The switch is already where it was asked to be, so a directory standing in for the marker path is
    // never touched — a reconciler that wrote again would fail on it and say so.
    mkdirSync(path);
    await reconcile();
    rmSync(path, { recursive: true, force: true });
    assert.deepEqual(logged, []);
    assert.equal(UA_TOKEN_DISABLED_MARKER_PATH, "/tmp/slate-ua-token-disabled");
  });
});

describe("where a host bundle comes from", () => {
  it("names our own bundle, and lets an override stand in for it", () => {
    assert.equal(HOST_BUNDLE_PREFIX, "slate-host-bundle");
    assert.equal(HOST_BUNDLE_REGION, "us-east-1");
    assert.equal(HOST_BUNDLE_BUCKET, "public-slate-host-bundle");
    assert.equal(hostBundleBaseUrl(), `https://public-slate-host-bundle.s3.us-east-1.amazonaws.com/slate-host-bundle`);
    process.env.SLATE_HOST_BUNDLE_S3_BASE_URL = "https://bundles.example.com/";
    assert.equal(hostBundleBaseUrl(), "https://bundles.example.com");
    delete process.env.SLATE_HOST_BUNDLE_S3_BASE_URL;
    assert.equal(hostBundleTarballUrl("abc1234"), `${hostBundleBaseUrl()}/slate-host-bundle-abc1234.tgz`);
  });

  it("takes a version only when it looks like one, and remembers it for a while", async () => {
    clearHostBundleVersionCache();
    let fetches = 0;
    const fetchOnce = (async () => { fetches += 1; return { ok: true, text: async () => "abc1234\n" }; }) as unknown as typeof fetch;
    assert.equal(await fetchLatestHostBundleVersion(fetchOnce), "abc1234");
    assert.equal(await fetchLatestHostBundleVersion(fetchOnce), "abc1234");
    assert.equal(fetches, 1);
    clearHostBundleVersionCache();
    assert.equal(await fetchLatestHostBundleVersion((async () => ({ ok: true, text: async () => "not a sha" })) as unknown as typeof fetch), undefined);
    assert.equal(await fetchLatestHostBundleVersion((async () => ({ ok: false, text: async () => "" })) as unknown as typeof fetch), undefined);
    assert.equal(await fetchLatestHostBundleVersion((async () => { throw new Error("offline"); }) as unknown as typeof fetch), undefined);
    assert.equal(await resolveHostBundleSource((async () => ({ ok: false, text: async () => "" })) as unknown as typeof fetch), undefined);
    clearHostBundleVersionCache();
  });

  it("refuses a bundle it cannot fetch or that is empty", async () => {
    await assert.rejects(() => fetchHostBundleTarball((async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer })) as unknown as typeof fetch, "not-a-sha"), SlateHostBundleSourceError);
    await assert.rejects(() => fetchHostBundleTarball((async () => ({ ok: false, status: 404 })) as unknown as typeof fetch, "abc1234"), /status 404/);
    await assert.rejects(() => fetchHostBundleTarball((async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch, "abc1234"), /empty tarball/);
    const bytes = await fetchHostBundleTarball((async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer })) as unknown as typeof fetch, "abc1234");
    assert.equal(bytes.byteLength, 2);
  });
});
