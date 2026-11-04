/**
 * The host's small runtime pieces: who the user is, what a box may be pointed at, when a phone is told, and
 * the little guards the runner leans on — clock skew, site visits, video containers, secrets and the files the
 * host keeps to itself.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { normalizeSlateUserFullName, renderUserIdentitySystemPrompt, MAX_FULL_NAME_LENGTH } from "../../source/host/slate-user-identity.ts";
import { publishTranscriptMutation, subscribeTranscriptMutations, type TranscriptMutation } from "../../source/host/transcript/transcript-mutation-events.ts";
import { StatKeyedParseCache, RACY_MTIME_TICK_WINDOW_MS, mtimeTickCouldStillHideAnEdit } from "../../source/host/workflows/stat-keyed-parse-cache.ts";
import { applyBoxEnvironmentViaTransport, type BoxEnvironmentControlClient } from "../../source/adapters/interop/agent/box-environment-transport-adapter.ts";
import { buildHostShellArgs } from "../../source/adapters/interop/agent/box-shell-command-adapter.ts";
import { assertPathOutsideProtectedRoots, SlateProtectedPathError } from "../../source/host/boxes/protected-path-guard.ts";
import { augmentWatchResultWithTranscriptDump, cloudAgentTranscriptDumpPath, dumpCloudAgentTranscript, formatCloudAgentDumpCompletionLine } from "../../source/host/cloud-agents/cloud-agent-transcript-dump.ts";
import { GROUP_MAX_MEMBERS, getSlateGroupPath, isSlateGroupDir, normalizeMemberIds, normalizeRemoteMembers, readSlateGroupConfig, writeSlateGroupConfig } from "../../source/host/groups/group-store.ts";
import { createSlateMobilePushSender } from "../../source/adapters/interop/cursor-backend/mobile-push-adapter.ts";
import { SlateMobilePushNotifier, SLATE_MOBILE_PUSH_FOCUS_FRESHNESS_MS, type MobilePushInput } from "../../source/host/notifications/mobile-push-notifier.ts";
import { createSlateTransport } from "../../source/host/ports/transport.ts";
import { bucketClockSkewDeltaMs, sanitizeCrossClockDurationMs, SEND_DISPATCH_MAX_PLAUSIBLE_MS } from "../../source/host/runner/clock-skew-guard.ts";
import { visitedSiteHost, withSiteVisitTracking, type AuditRecord } from "../../source/host/runner/site-visit-tracking.ts";
import { readMcpInstalledListing, resolveMcpServerRowByIdentifierOrLegacyId, resolveMcpServerRowsByIdentifierOrLegacyId } from "../../source/host/runner/tools/mcp-server-resolution.ts";
import { buildSecretProvidedAck, clampSecretDescription, clampSecretLabel, SECRET_REQUEST_MAX_DESCRIPTION_LENGTH, SECRET_REQUEST_MAX_LABEL_LENGTH, summarizeSecretRequest } from "../../source/host/runner/tools/slate-secret-request.ts";
import { bytesLookLikeVideoContainer } from "../../source/host/runner/video-container.ts";
import { BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES, SLATE_ACK_OBLIGATIONS_FILE_NAME, SLATE_UPGRADE_RESUME_FILE_NAME } from "../../source/host/durable-file-policy.ts";
import { summarizePermissionRequest } from "../../source/host/runner/tools/slate-permission-request.ts";
import type { Context } from "../../source/packages/context/context.ts";
import type { NotificationAgent } from "../../source/shared/os-notification.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-runtime-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

function agent(overrides: Partial<NotificationAgent> & { id: string }): NotificationAgent {
  return { name: overrides.id, isRunning: false, notifyOnUpdatesEnabled: true, ...overrides };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("the user, as the agent is told them", () => {
  it("bounded, and a name that says nothing is not one", () => {
    assert.equal(normalizeSlateUserFullName(null), undefined);
    assert.equal(normalizeSlateUserFullName("   "), undefined);
    assert.equal(normalizeSlateUserFullName("  Ada Lovelace  "), "Ada Lovelace");
    assert.equal(normalizeSlateUserFullName("x".repeat(MAX_FULL_NAME_LENGTH + 50))?.length, MAX_FULL_NAME_LENGTH);
  });

  it("is told to speak as the user rather than about them", () => {
    assert.equal(renderUserIdentitySystemPrompt(undefined), "");
    assert.equal(renderUserIdentitySystemPrompt("  "), "");
    const prompt = renderUserIdentitySystemPrompt("Ada");
    assert.match(prompt, /You are acting for Ada\./);
    assert.match(prompt, /write from their perspective/);
    assert.match(prompt, /do not describe them as an outside person/);
  });
});

describe("transcript mutation listeners", () => {
  it("tells every listener even when one of them throws, and stops telling an unsubscribed one", () => {
    const seen: string[] = [];
    const unsubscribeThrowing = subscribeTranscriptMutations(() => { throw new Error("this observer is broken"); });
    const unsubscribe = subscribeTranscriptMutations((mutation: TranscriptMutation) => { seen.push(mutation.kind); });
    publishTranscriptMutation({ kind: "appended" });
    unsubscribe();
    publishTranscriptMutation({ kind: "replaced" });
    unsubscribeThrowing();
    assert.deepEqual(seen, ["appended"]);
  });
});

describe("parsing a file again only when it changed", () => {
  it("parses once, re-parses after a change and forgets a file that is gone", async () => {
    const file = join(scratch, "cache-target.json");
    writeFileSync(file, "one");
    const cache = new StatKeyedParseCache(16, () => Date.now() + 60_000);
    let parses = 0;
    const parse = () => { parses += 1; return { n: parses }; };
    assert.deepEqual(cache.read([file], parse), { n: 1 });
    assert.deepEqual(cache.read([file], parse), { n: 1 });
    assert.equal(parses, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(file, "two");
    assert.deepEqual(cache.read([file], parse), { n: 2 });
    rmSync(file);
    assert.equal(cache.read([file], parse), null);
  });

  it("answers a file whose modification time could still hide an edit but does not cache it", () => {
    const file = join(scratch, "racy.json");
    writeFileSync(file, "racy");
    const nowMs = Date.now();
    assert.equal(mtimeTickCouldStillHideAnEdit({ newestMtimeMs: nowMs - RACY_MTIME_TICK_WINDOW_MS + 1 }, nowMs), true);
    assert.equal(mtimeTickCouldStillHideAnEdit({ newestMtimeMs: nowMs - RACY_MTIME_TICK_WINDOW_MS - 1 }, nowMs), false);
    const cache = new StatKeyedParseCache(16, () => Date.now());
    let parses = 0;
    const parse = () => { parses += 1; return parses; };
    assert.equal(cache.read([file], parse), 1);
    assert.equal(cache.read([file], parse), 2);
  });

  it("keeps the cache bounded", () => {
    const cache = new StatKeyedParseCache(2, () => Date.now() + 60_000);
    const paths = ["a.json", "b.json", "c.json"].map((name) => {
      const file = join(scratch, name);
      writeFileSync(file, name);
      return file;
    });
    for (const file of paths) cache.read([file], () => file);
    let parses = 0;
    const parse = () => { parses += 1; return parses; };
    cache.read([paths[0] as string], parse);
    cache.read([paths[0] as string], parse);
    assert.equal(parses, 1);
  });
});

describe("what a box is given", () => {
  it("hands the environment to the control client it was opened over, as a copy", async () => {
    const calls: Array<{ env: Record<string, string>; replace: boolean }> = [];
    const createClient = (transport: { readonly name: string }): BoxEnvironmentControlClient => ({
      updateEnvironmentVariables: async (_ctx: Context, request) => { calls.push({ env: request.env, replace: request.replace }); return { transport: transport.name }; },
    });
    const env = { SLATE_FEATURE: "on" };
    await applyBoxEnvironmentViaTransport({} as Context, { name: "control" }, { env, replace: true }, createClient);
    assert.deepEqual(calls, [{ env: { SLATE_FEATURE: "on" }, replace: true }]);
    assert.notEqual(calls[0]?.env, env);
  });

  it("runs the command itself and carries the parse it already did", () => {
    const args = buildHostShellArgs({ command: "ls -la /workspace", name: "ls", workingDirectory: "/workspace", toolCallId: "call-1" });
    assert.equal(args.command, "ls -la /workspace");
    assert.equal(args.workingDirectory, "/workspace");
    assert.equal(args.toolCallId, "call-1");
    assert.equal(args.skipApproval, true);
    assert.equal(args.parsingResult?.parsingFailed, false);
    assert.equal(args.parsingResult?.hasRedirects, false);
    assert.equal(args.parsingResult?.executableCommands[0]?.name, "ls");
    assert.equal(args.parsingResult?.executableCommands[0]?.fullText, "ls -la /workspace");
  });
});

describe("paths that belong to the host", () => {
  it("refuses a path inside a protected root and allows one outside it", async () => {
    const root = join(scratch, "host-state");
    mkdirSync(root, { recursive: true });
    await assert.rejects(
      () => assertPathOutsideProtectedRoots([root], join(root, "state.json"), scratch),
      (error: unknown) => error instanceof SlateProtectedPathError && /protected host-only store/.test((error as Error).message),
    );
    await assert.rejects(() => assertPathOutsideProtectedRoots([root], "state.json", root), SlateProtectedPathError);
    await assert.doesNotReject(() => assertPathOutsideProtectedRoots([root], join(scratch, "elsewhere.json"), scratch));
    await assert.doesNotReject(() => assertPathOutsideProtectedRoots([], join(root, "state.json"), scratch));
  });

  it("treats the protected root itself as inside, and resolves relative traversal against its base", async () => {
    const root = join(scratch, "host-state");
    mkdirSync(root, { recursive: true });

    await assert.rejects(() => assertPathOutsideProtectedRoots([root], root, scratch), SlateProtectedPathError);
    await assert.rejects(() => assertPathOutsideProtectedRoots([root], "host-state/../host-state/state.json", scratch), SlateProtectedPathError);
    await assert.doesNotReject(() => assertPathOutsideProtectedRoots([root], "../outside/state.json", root));
  });

  it("refuses a symlink that leads into a protected root", async () => {
    const root = join(scratch, "protected-real");
    mkdirSync(root, { recursive: true });
    const link = join(scratch, "looks-harmless");
    symlinkSync(root, link);
    await assert.rejects(() => assertPathOutsideProtectedRoots([root], join(link, "state.json"), scratch), SlateProtectedPathError);
  });

  it("recognizes a protected root through a symlink alias", async () => {
    const root = join(scratch, "protected-alias-target");
    mkdirSync(root, { recursive: true });
    const alias = join(scratch, "protected-alias");
    symlinkSync(root, alias);

    await assert.rejects(() => assertPathOutsideProtectedRoots([alias], join(root, "state.json"), scratch), SlateProtectedPathError);
  });
});

describe("a cloud agent's transcript, dumped into its box", () => {
  it("writes the file only when there are lines, and says how to read the end of it", async () => {
    const written: Array<{ path: string; size: number }> = [];
    const api = { getTranscriptDump: async () => ({ status: "completed", lineCount: 3, jsonl: "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n" }) };
    const outcome = await dumpCloudAgentTranscript({
      api,
      bcId: "bc-7",
      writeBoxFile: async (path, data) => { written.push({ path, size: data.byteLength }); },
    });
    assert.equal(outcome?.lineCount, 3);
    assert.equal(outcome?.file?.path, cloudAgentTranscriptDumpPath("bc-7"));
    assert.deepEqual(written, [{ path: "cloud-agent-transcripts/bc-7.jsonl", size: 24 }]);
    const line = formatCloudAgentDumpCompletionLine({ path: "cloud-agent-transcripts/bc-7.jsonl", sizeBytes: 24 }, 3);
    assert.match(line, /Full transcript dumped to cloud-agent-transcripts\/bc-7\.jsonl \(24 bytes, 3 message lines\)/);
    assert.match(line, /tail -n 1/);
  });

  it("writes nothing for a transcript with no lines", async () => {
    let wrote = false;
    const outcome = await dumpCloudAgentTranscript({
      api: { getTranscriptDump: async () => ({ status: "running", lineCount: 0, jsonl: "" }) },
      bcId: "bc-8",
      writeBoxFile: async () => { wrote = true; },
    });
    assert.deepEqual(outcome, { status: "running", lineCount: 0 });
    assert.equal(wrote, false);
  });

  it("leaves the watch result alone when the dump cannot be fetched", async () => {
    const result = { text: "the agent's report" };
    const augmented = await augmentWatchResultWithTranscriptDump({
      api: { getTranscriptDump: async () => { throw new Error("backend is away"); } },
      bcId: "bc-9",
      writeBoxFile: async () => {},
      result,
    });
    assert.equal(augmented, result);
  });
});

describe("the group an agent belongs to", () => {
  it("round-trips a group beside the agent and says what an empty one is", () => {
    const dir = join(scratch, "agents", "a1");
    assert.equal(readSlateGroupConfig(dir), null);
    assert.equal(isSlateGroupDir(dir), false);
    writeSlateGroupConfig(dir, { version: 1, memberIds: [" a2 ", "a2", "a3"], sharedRoomId: "room-1" });
    const read = readSlateGroupConfig(dir);
    assert.deepEqual(read?.memberIds, ["a2", "a3"]);
    assert.equal(read?.sharedRoomId, "room-1");
    assert.equal(read?.version, 1);
    assert.equal(isSlateGroupDir(dir), true);
    assert.equal(getSlateGroupPath(dir), join(dir, "group.json"));
    assert.equal(readSlateGroupConfig(join(scratch, "agents", "nobody")), null);
  });

  it("bounds and de-duplicates both kinds of member", () => {
    assert.deepEqual(normalizeMemberIds("not an array"), []);
    assert.deepEqual(normalizeMemberIds([1, null, "", "  ", "a", "a", "b"]), ["a", "b"]);
    assert.equal(normalizeMemberIds(Array.from({ length: 20 }, (_value, index) => `m${index}`)).length, GROUP_MAX_MEMBERS);
    const remote = normalizeRemoteMembers([
      { ownerAuthId: " o1 ", agentId: " a1 ", name: "  " },
      { ownerAuthId: "o1", agentId: "a1", name: "duplicate" },
      { ownerAuthId: "o2", agentId: "", name: "no agent" },
      "not an object",
      { ownerAuthId: "o3", agentId: "a3", name: "Remote", avatarDataUrl: "data:image/png;base64,AA" },
    ]);
    assert.deepEqual(remote, [
      { ownerAuthId: "o1", agentId: "a1", name: "Agent" },
      { ownerAuthId: "o3", agentId: "a3", name: "Remote", avatarDataUrl: "data:image/png;base64,AA" },
    ]);
  });
});

describe("telling a phone that an agent needs its user", () => {
  it("holds what arrives before the baseline and replays it once the baseline is seeded", async () => {
    const pushes: MobilePushInput[] = [];
    const notifier = new SlateMobilePushNotifier({ notify: async (input) => { pushes.push(input); }, now: () => 1_000_000 });
    notifier.handleAgentUpsertedEvent(
      { agent: agent({ id: "a1", isRunning: false, awaitingUserResponse: { reason: "needs approval" } }) },
      { windowFocusedAtMs: null },
    );
    await tick();
    assert.equal(pushes.length, 0);
    notifier.seedBaseline([agent({ id: "a1", isRunning: true })]);
    await tick();
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]?.agentId, "a1");
    assert.equal(pushes[0]?.awaitingUserResponse, true);
  });

  it("counts a phone's idea of presence as focused while it is fresh", async () => {
    const pushes: MobilePushInput[] = [];
    let nowMs = 1_000_000;
    const notifier = new SlateMobilePushNotifier({ notify: async (input) => { pushes.push(input); }, now: () => nowMs });
    notifier.seedBaseline([agent({ id: "a1", isRunning: true })]);
    notifier.handleAgentsEvent(
      { agents: [agent({ id: "a1", isRunning: false, lastMessageId: "m1", lastMessagePreview: "done" })] },
      { windowFocusedAtMs: nowMs - SLATE_MOBILE_PUSH_FOCUS_FRESHNESS_MS + 1 },
    );
    await tick();
    assert.equal(pushes.length, 0);
    nowMs += 10_000;
    notifier.handleAgentsEvent(
      { agents: [agent({ id: "a1", isRunning: true, lastMessageId: "m1" })] },
      { windowFocusedAtMs: null },
    );
    notifier.handleAgentsEvent(
      { agents: [agent({ id: "a1", isRunning: false, lastMessageId: "m2", lastMessagePreview: "and more" })] },
      { windowFocusedAtMs: null },
    );
    await tick();
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]?.awaitingUserResponse, false);
    assert.equal(pushes[0]?.messagePreview, "and more");
    assert.equal(pushes[0]?.lastMessageId, "m2");
  });

  it("sends what the platform's push client expects", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const send = createSlateMobilePushSender({ notifySlateAgentTurnFinished: async (input) => { sent.push({ ...input }); } });
    await send({ agentId: "a1", agentName: "Researcher", awaitingUserResponse: true });
    assert.deepEqual(sent, [{ agentId: "a1", agentName: "Researcher", messagePreview: "", lastMessageId: "", awaitingUserResponse: true }]);
  });
});

describe("the transport remembers what it answered", () => {
  it("keeps the assigned id for a sent message and whether a reaction landed", () => {
    const transport = createSlateTransport((update) =>
      update.type === "send-message" ? "msg-1" : update.emoji === "thumbsup" ? "reaction-1" : undefined);
    assert.equal(transport.lastSentMessageId(), undefined);
    transport.onUpdate({ type: "send-message" });
    assert.equal(transport.lastSentMessageId(), "msg-1");
    assert.equal(transport.lastReactionApplied(), false);
    transport.onUpdate({ type: "react-to-message", emoji: "eyes" });
    assert.equal(transport.lastReactionApplied(), false);
    transport.onUpdate({ type: "react-to-message", emoji: "thumbsup" });
    assert.equal(transport.lastReactionApplied(), true);
  });
});

describe("durations measured across two clocks", () => {
  it("accepts a plausible duration, rounds it, and reports the skew it looks like", () => {
    assert.deepEqual(sanitizeCrossClockDurationMs(1_234.6, SEND_DISPATCH_MAX_PLAUSIBLE_MS), { ms: 1_235 });
    assert.deepEqual(sanitizeCrossClockDurationMs(-1, SEND_DISPATCH_MAX_PLAUSIBLE_MS), { skewReason: "negative" });
    assert.deepEqual(sanitizeCrossClockDurationMs(SEND_DISPATCH_MAX_PLAUSIBLE_MS + 1, SEND_DISPATCH_MAX_PLAUSIBLE_MS), { skewReason: "too_large" });
    assert.deepEqual(sanitizeCrossClockDurationMs(Number.POSITIVE_INFINITY, SEND_DISPATCH_MAX_PLAUSIBLE_MS), { skewReason: "too_large" });
    assert.deepEqual(sanitizeCrossClockDurationMs(Number.NaN, SEND_DISPATCH_MAX_PLAUSIBLE_MS), { skewReason: "too_large" });
  });

  it("buckets a skew for reporting rather than carrying the raw number", () => {
    assert.equal(bucketClockSkewDeltaMs(Number.NaN), "nonfinite");
    assert.equal(bucketClockSkewDeltaMs(-500), "neg_le_1s");
    assert.equal(bucketClockSkewDeltaMs(-30_000), "neg_le_1m");
    assert.equal(bucketClockSkewDeltaMs(-90_000), "neg_gt_1m");
    assert.equal(bucketClockSkewDeltaMs(30_000), "le_1m");
    assert.equal(bucketClockSkewDeltaMs(200_000), "le_5m");
    assert.equal(bucketClockSkewDeltaMs(600_000), "le_15m");
    assert.equal(bucketClockSkewDeltaMs(1_800_000), "gt_15m");
  });
});

describe("noticing the sites a browser visited", () => {
  it("reports the site without the www prefix, after the record was audited", () => {
    const order: string[] = [];
    const auditor = withSiteVisitTracking(
      { record: () => { order.push("audited"); } },
      (visit, record) => { order.push(`visited ${visit.host} from ${record.action.kind}`); },
    );
    auditor.record({ action: { kind: "browserNavigation", url: "https://www.example.com/page" } });
    auditor.record({ action: { kind: "browserNavigation", url: "https://docs.example.com/x" } });
    auditor.record({ action: { kind: "browserNavigation", url: "not a url" } });
    auditor.record({ action: { kind: "shellCommand" } });
    assert.deepEqual(order, ["audited", "visited example.com from browserNavigation", "audited", "visited docs.example.com from browserNavigation", "audited", "audited"]);
    assert.equal(visitedSiteHost("https://www.example.com/"), "example.com");
    assert.equal(visitedSiteHost("about:blank"), undefined);
  });
});

describe("finding an MCP server by the identifier it is known by", () => {
  const rows = [
    { id: "legacy-1", serverIdentifier: "linear" },
    { id: "legacy-2", serverIdentifier: "slack" },
  ];

  it("prefers the identifier and still accepts an older id", () => {
    assert.deepEqual(resolveMcpServerRowsByIdentifierOrLegacyId(rows, " linear "), [rows[0]]);
    assert.deepEqual(resolveMcpServerRowsByIdentifierOrLegacyId(rows, "legacy-2"), [rows[1]]);
    assert.deepEqual(resolveMcpServerRowsByIdentifierOrLegacyId(rows, "  "), []);
    assert.deepEqual(resolveMcpServerRowsByIdentifierOrLegacyId(rows, "nothing"), []);
    assert.equal(resolveMcpServerRowByIdentifierOrLegacyId(rows, "slack")?.id, "legacy-2");
    assert.equal(resolveMcpServerRowByIdentifierOrLegacyId(rows, "nothing"), null);
  });

  it("reports a listing it cannot read as unreadable rather than as an empty one", async () => {
    assert.deepEqual(await readMcpInstalledListing(async () => rows), { kind: "read", servers: rows });
    assert.deepEqual(await readMcpInstalledListing(async () => { throw new Error("no listing"); }), { kind: "unreadable" });
  });

  it("keeps every row the identifier names, and only falls back to an older id when none is named", () => {
    const duplicated = [
      { id: "a", serverIdentifier: "github" },
      { id: "b", serverIdentifier: "github" },
      { id: "github", serverIdentifier: "other" },
    ];
    assert.deepEqual(resolveMcpServerRowsByIdentifierOrLegacyId(duplicated, "github"), [duplicated[0], duplicated[1]], "the identifier answers with every row it names, before any older id is tried");
    assert.deepEqual(resolveMcpServerRowsByIdentifierOrLegacyId(duplicated, "other"), [duplicated[2]]);
    assert.deepEqual(resolveMcpServerRowsByIdentifierOrLegacyId([], "x"), []);
    assert.deepEqual(resolveMcpServerRowsByIdentifierOrLegacyId(rows, ""), []);
    assert.deepEqual(resolveMcpServerRowsByIdentifierOrLegacyId([{ id: "", serverIdentifier: "" }], "   "), [], "an empty token asks for nothing, not for the row filed under nothing");
    assert.equal(resolveMcpServerRowByIdentifierOrLegacyId(duplicated, "github")?.id, "a", "the first row named is the one answered")
  });

  it("reads a listing that fails in any way as unreadable, and an empty one as read", async () => {
    assert.deepEqual(await readMcpInstalledListing(async () => []), { kind: "read", servers: [] });
    assert.deepEqual(await readMcpInstalledListing(async () => Promise.reject(new Error("rejected"))), { kind: "unreadable" });
    assert.deepEqual(await readMcpInstalledListing(() => { throw new Error("sync failure"); }), { kind: "unreadable" });
    assert.deepEqual(await readMcpInstalledListing(7 as never), { kind: "unreadable" }, "a listing that is not a loader is unreadable too")
  });
});

describe("asking the user for a secret", () => {
  it("bounds what is asked for", () => {
    assert.equal(clampSecretLabel("  line one\nline two  "), "line one line two");
    assert.equal(clampSecretLabel("x".repeat(SECRET_REQUEST_MAX_LABEL_LENGTH + 10)).length, SECRET_REQUEST_MAX_LABEL_LENGTH);
    assert.equal(clampSecretDescription("  first\n\n\n\nsecond  "), "first\n\n\n\nsecond");
    assert.equal(clampSecretDescription("y".repeat(SECRET_REQUEST_MAX_DESCRIPTION_LENGTH + 10)).length, SECRET_REQUEST_MAX_DESCRIPTION_LENGTH);
    assert.equal(summarizeSecretRequest({ label: "GitHub token" }), "Secure secret input requested: GitHub token");
  });

  it("acknowledges a provided secret as one the agent never sees", () => {
    const ack = buildSecretProvidedAck({ label: "GitHub token", target: { kind: "connector" } });
    assert.match(ack, /\[GitHub token was supplied through the secure input and saved directly to connector;/);
    assert.match(ack, /the value is not available here and was not added to the conversation/);
    assert.match(ack, /Tell the user it is set/);
  });
});

describe("a file's first bytes", () => {
  it("recognizes the containers the common formats start with", () => {
    const withMarker = (bytes: number[]) => new Uint8Array([...bytes, ...new Array<number>(32).fill(0)]);
    assert.equal(bytesLookLikeVideoContainer(withMarker([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])), true);
    assert.equal(bytesLookLikeVideoContainer(withMarker([0x4f, 0x67, 0x67, 0x53])), true);
    assert.equal(bytesLookLikeVideoContainer(withMarker([0x46, 0x4c, 0x56])), true);
    assert.equal(bytesLookLikeVideoContainer(withMarker([0, 0, 0, 0, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])), true);
    assert.equal(bytesLookLikeVideoContainer(withMarker([0x1a, 0x45, 0xdf, 0xa3])), true);
    assert.equal(bytesLookLikeVideoContainer(withMarker([0x00, 0x00, 0x01, 0xba])), true);
    assert.equal(bytesLookLikeVideoContainer(withMarker([0x00, 0x00, 0x01, 0xb3])), true);
    assert.equal(bytesLookLikeVideoContainer(withMarker([0x7b, 0x22, 0x61, 0x22])), false);
    assert.equal(bytesLookLikeVideoContainer(new Uint8Array(0)), false);
  });
});

describe("the files the host keeps to itself", () => {
  it("names them, and excludes them from a box's store", () => {
    assert.equal(SLATE_UPGRADE_RESUME_FILE_NAME, "host-upgrade-resume.json");
    assert.equal(SLATE_ACK_OBLIGATIONS_FILE_NAME, "ack-obligations.json");
    assert.deepEqual([...BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES], [
      "host-upgrade-resume.json",
      "ack-obligations.json",
      "host-pending-wakes.json",
      "host-xuser-turn-nonces.json",
      "host-disk-pressure-reminders.json",
    ]);
  });
});

describe("a permission request that can no longer be acted on", () => {
  it("is summarized as one from an older version", () => {
    assert.equal(summarizePermissionRequest({ title: "Run tests", reason: "needs the shell" }), "Legacy permission request (no longer actionable): Run tests — needs the shell");
  });
});
